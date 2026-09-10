const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;
const TAR_BLOCK_SIZE = 512;

const FONT_PATH = /\.(?:otf|ttf|ttc|woff)$/i;
const WOFF2_PATH = /\.woff2$/i;

export interface ExtractedFontFile {
  path: string;
  bytes: Uint8Array;
}

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const decompress = async (
  bytes: Uint8Array,
  format: 'gzip' | 'deflate-raw',
): Promise<Uint8Array> => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(`当前浏览器不支持 ${format === 'gzip' ? 'gzip' : 'ZIP'} 解压`);
  }
  let transform: DecompressionStream;
  try {
    transform = new DecompressionStream(format);
  } catch (reason) {
    console.info('初始化字体解压器失败', reason);
    throw new Error(`当前浏览器不支持 ${format === 'gzip' ? 'gzip' : 'ZIP'} 解压`);
  }
  const stream = new Blob([ownedBuffer(bytes)]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const decodeName = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\\/g, '/');

const fontMagic = (bytes: Uint8Array): 'supported' | 'woff2' | undefined => {
  if (bytes.byteLength < 4) return undefined;
  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (signature === 'wOF2') return 'woff2';
  if (
    signature === 'OTTO' ||
    signature === 'ttcf' ||
    signature === 'true' ||
    signature === 'typ1' ||
    signature === 'wOFF' ||
    (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
  ) {
    return 'supported';
  }
  return undefined;
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const fontArchiveCrc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const verifyFontCollection = (
  fonts: ExtractedFontFile[],
  ignoredWoff2: number,
  label: string,
): ExtractedFontFile[] => {
  if (fonts.length) return fonts;
  if (ignoredWoff2) {
    throw new Error(`${label} 中只有 WOFF2 字体；当前运行时不支持 WOFF2`);
  }
  throw new Error(`${label} 中没有找到 TTF、OTF、TTC 或 WOFF 字体`);
};

const findZipEnd = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      view.getUint32(offset, true) === ZIP_END &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      return offset;
    }
  }
  throw new Error('ZIP 中央目录缺失或文件不完整');
};

const extractZipFonts = async (zip: Uint8Array): Promise<ExtractedFontFile[]> => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = findZipEnd(zip);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const entryCount = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (disk || centralDisk || diskEntries !== entryCount) throw new Error('不支持分卷 ZIP 字体包');
  if (centralOffset + centralSize > end) throw new Error('ZIP 中央目录范围无效');

  const fonts: ExtractedFontFile[] = [];
  let ignoredWoff2 = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE) {
      throw new Error('ZIP 中央目录条目无效');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const expectedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > zip.byteLength) throw new Error('ZIP 中央目录条目不完整');
    const path = decodeName(zip.subarray(offset + 46, offset + 46 + nameLength));
    offset = nextOffset;

    if (WOFF2_PATH.test(path)) {
      ignoredWoff2 += 1;
      continue;
    }
    if (!FONT_PATH.test(path) || path.endsWith('/')) continue;
    if (flags & 1) throw new Error(`ZIP 中的字体已加密，无法读取：${path}`);
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL
    ) {
      throw new Error(`暂不支持 ZIP64 字体条目：${path}`);
    }
    if (localOffset + 30 > zip.byteLength || view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE) {
      throw new Error(`ZIP 本地条目无效：${path}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > zip.byteLength) throw new Error(`ZIP 字体数据不完整：${path}`);

    const packed = zip.slice(dataOffset, dataEnd);
    let bytes: Uint8Array;
    if (method === 0) {
      bytes = packed;
    } else if (method === 8) {
      bytes = await decompress(packed, 'deflate-raw');
    } else {
      throw new Error(`ZIP 字体使用了不支持的压缩算法 ${method}：${path}`);
    }
    if (bytes.byteLength !== uncompressedSize) throw new Error(`ZIP 字体大小校验失败：${path}`);
    if (fontArchiveCrc32(bytes) !== expectedCrc) throw new Error(`ZIP 字体 CRC 校验失败：${path}`);
    if (fontMagic(bytes) !== 'supported') throw new Error(`压缩包内文件不是有效字体：${path}`);
    fonts.push({ path, bytes });
  }

  return verifyFontCollection(fonts, ignoredWoff2, 'ZIP 字体包');
};

const tarText = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)).trim();
};

const tarOctal = (field: Uint8Array, label: string): number => {
  if (field[0] & 0x80) throw new Error(`暂不支持使用 base-256 ${label}的 TAR 条目`);
  const value = tarText(field).replace(/^0+/, '') || '0';
  if (!/^[0-7]+$/.test(value)) throw new Error(`TAR 条目${label}无效`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`TAR 条目${label}超出支持范围`);
  return parsed;
};

const tarSize = (header: Uint8Array): number => {
  return tarOctal(header.subarray(124, 136), '大小');
};

const verifyTarChecksum = (header: Uint8Array): void => {
  const expected = tarOctal(header.subarray(148, 156), '校验和');
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw new Error('TAR 条目校验和失败');
};

const tarPath = (header: Uint8Array): string => {
  const name = tarText(header.subarray(0, 100));
  const prefix = tarText(header.subarray(345, 500));
  return (prefix ? `${prefix}/${name}` : name).replace(/\\/g, '/');
};

const paxPath = (bytes: Uint8Array): string | undefined => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    let space = offset;
    while (space < bytes.byteLength && bytes[space] !== 32) space += 1;
    if (space >= bytes.byteLength) break;
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(offset, space)), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.byteLength) break;
    const record = new TextDecoder()
      .decode(bytes.subarray(space + 1, offset + length))
      .replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals >= 0 && record.slice(0, equals) === 'path') return record.slice(equals + 1);
    offset += length;
  }
  return undefined;
};

const looksLikeTar = (bytes: Uint8Array): boolean => {
  if (bytes.byteLength < TAR_BLOCK_SIZE) return false;
  if (tarText(bytes.subarray(257, 263)).startsWith('ustar')) return true;
  try {
    const header = bytes.subarray(0, TAR_BLOCK_SIZE);
    verifyTarChecksum(header);
    const size = tarSize(header);
    return TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE <= bytes.byteLength;
  } catch {
    return false;
  }
};

const extractTarFonts = (tar: Uint8Array): ExtractedFontFile[] => {
  const fonts: ExtractedFontFile[] = [];
  let ignoredWoff2 = 0;
  let offset = 0;
  let pendingPath: string | undefined;

  while (offset + TAR_BLOCK_SIZE <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);
    const size = tarSize(header);
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataOffset + size;
    if (dataEnd > tar.byteLength) throw new Error('TAR 条目数据不完整');
    const type = header[156];
    const entryBytes = tar.slice(dataOffset, dataEnd);
    const headerPath = tarPath(header);

    if (type === 76) {
      pendingPath = tarText(entryBytes);
    } else if (type === 120) {
      pendingPath = paxPath(entryBytes) ?? pendingPath;
    } else {
      const path = (pendingPath ?? headerPath).replace(/\\/g, '/');
      pendingPath = undefined;
      if (type === 0 || type === 48) {
        if (WOFF2_PATH.test(path)) {
          ignoredWoff2 += 1;
        } else if (FONT_PATH.test(path)) {
          if (fontMagic(entryBytes) !== 'supported') {
            throw new Error(`压缩包内文件不是有效字体：${path}`);
          }
          fonts.push({ path, bytes: entryBytes });
        }
      }
    }

    offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return verifyFontCollection(fonts, ignoredWoff2, 'TAR 字体包');
};

const sourceFilename = (source: string): string => {
  try {
    const path = new URL(source).pathname;
    return decodeURIComponent(path.split('/').pop() || 'font');
  } catch {
    return source.split('/').pop() || 'font';
  }
};

export const extractFontFiles = async (
  bytes: Uint8Array,
  source: string,
): Promise<ExtractedFontFile[]> => {
  if (!bytes.byteLength) throw new Error('字体资源为空');
  const filename = sourceFilename(source);

  if (bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === ZIP_LOCAL_FILE) {
    return extractZipFonts(bytes);
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const unpacked = await decompress(bytes, 'gzip');
    if (looksLikeTar(unpacked)) return extractTarFonts(unpacked);
    const innerName = filename.replace(/\.(?:gz|gzip)$/i, '') || 'font';
    const kind = fontMagic(unpacked);
    if (kind === 'woff2') throw new Error('暂不支持 WOFF2 字体');
    if (kind !== 'supported') throw new Error('gzip 中既不是 TAR 字体包，也不是字体文件');
    return [{ path: innerName, bytes: unpacked }];
  }
  if (looksLikeTar(bytes)) return extractTarFonts(bytes);

  const kind = fontMagic(bytes);
  if (kind === 'woff2') throw new Error('暂不支持 WOFF2 字体');
  if (kind !== 'supported') {
    throw new Error('字体 URL 返回的内容不是受支持的字体、ZIP 或 tar.gz/tgz 压缩包');
  }
  return [{ path: filename, bytes }];
};

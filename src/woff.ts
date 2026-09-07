const WOFF_SIGNATURE = 0x774f4646;
const WOFF2_SIGNATURE = 0x774f4632;

const align4 = (value: number) => (value + 3) & ~3;

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const inflateZlib = async (bytes: Uint8Array): Promise<Uint8Array> => {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 WOFF 解压，请改用 TTF、OTF 或 TTC 字体');
  }
  const stream = new Blob([ownedBuffer(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export type FontContainer = 'woff' | 'woff2' | 'sfnt';

export const detectFontContainer = (bytes: Uint8Array): FontContainer => {
  if (bytes.byteLength < 4) return 'sfnt';
  const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (signature === WOFF_SIGNATURE) return 'woff';
  if (signature === WOFF2_SIGNATURE) return 'woff2';
  return 'sfnt';
};

export const convertWoffToSfnt = async (woff: Uint8Array): Promise<Uint8Array> => {
  if (woff.byteLength < 44) throw new Error('WOFF 文件头不完整');
  const input = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (input.getUint32(0) !== WOFF_SIGNATURE) throw new Error('文件不是 WOFF 1.0 字体');

  const declaredLength = input.getUint32(8);
  const numTables = input.getUint16(12);
  const declaredSfntSize = input.getUint32(16);
  if (declaredLength > woff.byteLength || !numTables || numTables > 4096) {
    throw new Error('WOFF 文件头无效');
  }
  if (44 + numTables * 20 > declaredLength) throw new Error('WOFF 字体表目录不完整');

  const tables: Array<{
    tag: number;
    checksum: number;
    originalLength: number;
    data: Uint8Array;
  }> = [];
  for (let index = 0; index < numTables; index += 1) {
    const directoryOffset = 44 + index * 20;
    const tag = input.getUint32(directoryOffset);
    const offset = input.getUint32(directoryOffset + 4);
    const compressedLength = input.getUint32(directoryOffset + 8);
    const originalLength = input.getUint32(directoryOffset + 12);
    const checksum = input.getUint32(directoryOffset + 16);
    if (
      !compressedLength ||
      !originalLength ||
      compressedLength > originalLength ||
      offset + compressedLength > declaredLength
    ) {
      throw new Error('WOFF 字体表数据无效');
    }

    const packed = woff.slice(offset, offset + compressedLength);
    const data = compressedLength < originalLength ? await inflateZlib(packed) : packed;
    if (data.byteLength !== originalLength) throw new Error('WOFF 字体表解压长度不匹配');
    tables.push({ tag, checksum, originalLength, data });
  }

  const directoryLength = 12 + numTables * 16;
  const computedSfntSize = tables.reduce(
    (size, table) => size + align4(table.originalLength),
    directoryLength,
  );
  if (declaredSfntSize < computedSfntSize) throw new Error('WOFF 声明的字体大小无效');

  const sfnt = new Uint8Array(declaredSfntSize);
  const output = new DataView(sfnt.buffer);
  output.setUint32(0, input.getUint32(4));
  output.setUint16(4, numTables);
  let powerOfTwo = 1;
  let entrySelector = 0;
  while (powerOfTwo * 2 <= numTables) {
    powerOfTwo *= 2;
    entrySelector += 1;
  }
  const searchRange = powerOfTwo * 16;
  output.setUint16(6, searchRange);
  output.setUint16(8, entrySelector);
  output.setUint16(10, numTables * 16 - searchRange);

  let tableOffset = directoryLength;
  tables.forEach((table, index) => {
    const recordOffset = 12 + index * 16;
    output.setUint32(recordOffset, table.tag);
    output.setUint32(recordOffset + 4, table.checksum);
    output.setUint32(recordOffset + 8, tableOffset);
    output.setUint32(recordOffset + 12, table.originalLength);
    sfnt.set(table.data, tableOffset);
    tableOffset += align4(table.originalLength);
  });

  return sfnt;
};

export const normalizeFontBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const container = detectFontContainer(bytes);
  if (container === 'woff') return convertWoffToSfnt(bytes);
  if (container === 'woff2') {
    throw new Error('暂不支持 WOFF2，请使用同一字体的 WOFF、TTF、OTF 或 TTC 文件');
  }
  return bytes;
};

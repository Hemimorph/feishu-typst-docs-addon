import { decompress as decompressZstd } from 'fzstd';
import type { ExtractedFontFile } from './font-archive';

const NIX_CACHE_ORIGIN = 'https://cache.nixos.org';
const NIX_STORE_PATH = /^\/nix\/store\/([0123456789abcdfghijklmnpqrsvwxyz]{32})-([^/\0]+)$/;
const NIX_BASE32 = '0123456789abcdfghijklmnpqrsvwxyz';
const FONT_PATH = /\.(?:otf|ttf|ttc|woff)$/i;
const WOFF2_PATH = /\.woff2$/i;
const MAX_NARINFO_BYTES = 64 * 1024;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_NAR_BYTES = 512 * 1024 * 1024;
const MAX_FONT_BYTES = 256 * 1024 * 1024;
const MAX_NAR_NODES = 100_000;
const MAX_NAR_DEPTH = 128;

interface NixNarInfo {
  storePath: string;
  url: string;
  compression: string;
  fileHash: string;
  fileSize: number;
  narHash: string;
  narSize: number;
}

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const errorDetail = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

export const parseNixOutPath = (
  value: string,
): { storePath: string; hashPart: string; name: string } => {
  const storePath = value.trim();
  const match = NIX_STORE_PATH.exec(storePath);
  if (!match) {
    throw new Error('Nix outPath 必须是 /nix/store/<32 位哈希>-<名称>');
  }
  return { storePath, hashPart: match[1], name: match[2] };
};

export const nixNarInfoUrl = (outPath: string): string => {
  const { hashPart } = parseNixOutPath(outPath);
  return `${NIX_CACHE_ORIGIN}/${hashPart}.narinfo`;
};

const parseSize = (value: string | undefined, label: string, maximum: number): number => {
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Nix narinfo 的 ${label} 无效`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Nix narinfo 的 ${label} 超出支持范围`);
  }
  if (parsed > maximum) {
    throw new Error(`Nix 字体包的 ${label} 过大（上限 ${Math.floor(maximum / 1024 / 1024)} MiB）`);
  }
  return parsed;
};

export const parseNixNarInfo = (text: string, requestedOutPath: string): NixNarInfo => {
  const { storePath } = parseNixOutPath(requestedOutPath);
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('Nix narinfo 包含无效行');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();
    if (!fields.has(key)) fields.set(key, value);
  }

  if (fields.get('StorePath') !== storePath) {
    throw new Error('Nix narinfo 的 StorePath 与请求的 outPath 不一致');
  }

  const rawUrl = fields.get('URL');
  if (!rawUrl) throw new Error('Nix narinfo 缺少 NAR 下载地址');
  let url: URL;
  try {
    url = new URL(rawUrl, `${NIX_CACHE_ORIGIN}/`);
  } catch {
    throw new Error('Nix narinfo 的 NAR 下载地址无效');
  }
  if (
    url.origin !== NIX_CACHE_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith('/nar/')
  ) {
    throw new Error('Nix narinfo 的 NAR 下载地址不属于 cache.nixos.org');
  }

  const fileHash = fields.get('FileHash');
  const narHash = fields.get('NarHash');
  if (!fileHash || !narHash) throw new Error('Nix narinfo 缺少 SHA-256 校验值');

  return {
    storePath,
    url: url.toString(),
    compression: fields.get('Compression') || 'bzip2',
    fileHash,
    fileSize: parseSize(fields.get('FileSize'), '下载大小', MAX_DOWNLOAD_BYTES),
    narHash,
    narSize: parseSize(fields.get('NarSize'), '解压大小', MAX_NAR_BYTES),
  };
};

const nixBase32 = (bytes: Uint8Array): string => {
  let result = '';
  const length = Math.ceil((bytes.byteLength * 8) / 5);
  for (let index = length - 1; index >= 0; index -= 1) {
    const bit = index * 5;
    const byte = Math.floor(bit / 8);
    const shift = bit % 8;
    const value =
      (bytes[byte] >>> shift) |
      (byte + 1 < bytes.byteLength ? bytes[byte + 1] << (8 - shift) : 0);
    result += NIX_BASE32[value & 0x1f];
  }
  return result;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器不支持 SHA-256 校验');
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', ownedBuffer(bytes)));
};

const verifySha256 = async (
  bytes: Uint8Array,
  expected: string,
  label: string,
): Promise<void> => {
  const digest = await sha256(bytes);
  let actual: string;
  if (expected.startsWith('sha256-')) {
    actual = `sha256-${base64(digest)}`;
  } else if (expected.startsWith('sha256:')) {
    const value = expected.slice('sha256:'.length);
    actual = `sha256:${/^[0-9a-f]{64}$/i.test(value) ? hex(digest) : nixBase32(digest)}`;
  } else {
    throw new Error(`Nix narinfo 的 ${label} 不是受支持的 SHA-256 格式`);
  }
  if (actual !== expected) throw new Error(`Nix 字体包的 ${label} 校验失败`);
};

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 gzip NAR 解压');
  }
  const stream = new Blob([ownedBuffer(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const decompressNixNar = async (
  bytes: Uint8Array,
  compression: string,
): Promise<Uint8Array> => {
  try {
    if (compression === 'zstd') return decompressZstd(bytes);
    if (compression === 'none') return bytes;
    if (compression === 'gzip') return await gunzip(bytes);
  } catch (reason) {
    throw new Error(`Nix NAR ${compression} 解压失败：${errorDetail(reason)}`);
  }
  throw new Error(`暂不支持 Nix binary cache 的 ${compression} 压缩格式`);
};

class NarReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  readBytes(): Uint8Array {
    if (this.offset + 8 > this.bytes.byteLength) throw new Error('NAR 字符串长度不完整');
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    );
    const low = view.getUint32(0, true);
    const high = view.getUint32(4, true);
    const length = high * 0x1_0000_0000 + low;
    if (!Number.isSafeInteger(length)) throw new Error('NAR 字符串长度超出支持范围');
    const start = this.offset + 8;
    const end = start + length;
    const paddedEnd = end + ((8 - (length % 8)) % 8);
    if (paddedEnd > this.bytes.byteLength) throw new Error('NAR 字符串内容不完整');
    for (let index = end; index < paddedEnd; index += 1) {
      if (this.bytes[index] !== 0) throw new Error('NAR 字符串填充无效');
    }
    this.offset = paddedEnd;
    return this.bytes.subarray(start, end);
  }

  readText(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  expect(value: string): void {
    if (this.readText() !== value) throw new Error(`NAR 结构无效：缺少 ${value}`);
  }
}

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

export const extractNixNarFonts = (
  nar: Uint8Array,
  rootName = 'nix-output',
): ExtractedFontFile[] => {
  const reader = new NarReader(nar);
  const fonts: ExtractedFontFile[] = [];
  let ignoredWoff2 = 0;
  let fontBytes = 0;
  let nodeCount = 0;

  const visit = (path: string, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > MAX_NAR_NODES) throw new Error('NAR 文件条目过多');
    if (depth > MAX_NAR_DEPTH) throw new Error('NAR 目录层级过深');

    reader.expect('(');
    reader.expect('type');
    const type = reader.readText();

    if (type === 'regular') {
      let field = reader.readText();
      if (field === 'executable') {
        reader.expect('');
        field = reader.readText();
      }
      if (field !== 'contents') throw new Error('NAR 普通文件缺少 contents');
      const contents = reader.readBytes();
      reader.expect(')');

      if (WOFF2_PATH.test(path)) {
        ignoredWoff2 += 1;
        return;
      }
      if (!FONT_PATH.test(path)) return;
      if (fontMagic(contents) !== 'supported') {
        throw new Error(`NAR 中的文件不是有效字体：${path}`);
      }
      fontBytes += contents.byteLength;
      if (fontBytes > MAX_FONT_BYTES) throw new Error('NAR 中的字体数据超过 256 MiB 上限');
      fonts.push({ path, bytes: contents.slice() });
      return;
    }

    if (type === 'symlink') {
      reader.expect('target');
      reader.readBytes();
      reader.expect(')');
      return;
    }

    if (type !== 'directory') throw new Error(`NAR 包含不支持的节点类型：${type}`);
    while (true) {
      const field = reader.readText();
      if (field === ')') return;
      if (field !== 'entry') throw new Error('NAR 目录条目无效');
      reader.expect('(');
      reader.expect('name');
      const name = reader.readText();
      if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
        throw new Error('NAR 目录条目名称不安全');
      }
      reader.expect('node');
      visit(path ? `${path}/${name}` : name, depth + 1);
      reader.expect(')');
    }
  };

  reader.expect('nix-archive-1');
  visit(rootName, 0);
  if (!reader.done) throw new Error('NAR 根节点之后存在多余数据');
  if (fonts.length) return fonts;
  if (ignoredWoff2) throw new Error('Nix 输出中只有 WOFF2 字体；当前运行时不支持 WOFF2');
  throw new Error('Nix 输出中没有找到 TTF、OTF、TTC 或 WOFF 字体');
};

const fetchBytes = async (url: string, label: string, maximum: number): Promise<Uint8Array> => {
  const limit =
    maximum >= 1024 * 1024
      ? `${Math.floor(maximum / 1024 / 1024)} MiB`
      : `${Math.floor(maximum / 1024)} KiB`;
  const response = await fetch(
    new Request(url, { method: 'GET', mode: 'cors', credentials: 'omit' }),
  );
  if (!response.ok) throw new Error(`${label}请求失败（${response.status}）`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    throw new Error(`${label}超过 ${limit} 上限`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) {
    throw new Error(`${label}超过 ${limit} 上限`);
  }
  return bytes;
};

export const loadNixOutPathFonts = async (outPath: string): Promise<ExtractedFontFile[]> => {
  const parsedPath = parseNixOutPath(outPath);
  const narInfoBytes = await fetchBytes(
    nixNarInfoUrl(parsedPath.storePath),
    'Nix narinfo ',
    MAX_NARINFO_BYTES,
  );
  const info = parseNixNarInfo(new TextDecoder().decode(narInfoBytes), parsedPath.storePath);
  const compressed = await fetchBytes(info.url, 'Nix NAR ', MAX_DOWNLOAD_BYTES);
  if (compressed.byteLength !== info.fileSize) throw new Error('Nix NAR 下载大小不一致');
  await verifySha256(compressed, info.fileHash, 'FileHash');

  const nar = await decompressNixNar(compressed, info.compression);
  if (nar.byteLength !== info.narSize) throw new Error('Nix NAR 解压大小不一致');
  await verifySha256(nar, info.narHash, 'NarHash');
  return extractNixNarFonts(nar, parsedPath.name);
};

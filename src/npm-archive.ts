import type { TypstRuntimeAssetLocation } from './model';

const TAR_BLOCK_SIZE = 512;
const archiveCache = new Map<string, Promise<Uint8Array>>();

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const decodeTarText = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
};

const readTarSize = (header: Uint8Array): number => {
  const value = decodeTarText(header.subarray(124, 136)).replace(/^0+/, '') || '0';
  if (!/^[0-7]+$/.test(value)) throw new Error('npm 包中的 tar 文件大小无效');
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('npm 包中的 tar 文件大小超出支持范围');
  }
  return size;
};

const tarEntryName = (header: Uint8Array): string => {
  const name = decodeTarText(header.subarray(0, 100));
  const prefix = decodeTarText(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
};

export const extractTarEntry = (tar: Uint8Array, requestedPath: string): Uint8Array => {
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const size = readTarSize(header);
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataOffset + size;
    if (dataEnd > tar.length) throw new Error('npm 包中的 tar 条目不完整');

    const type = header[156];
    if (tarEntryName(header) === requestedPath && (type === 0 || type === 48)) {
      return tar.slice(dataOffset, dataEnd);
    }

    offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  throw new Error(`npm 包中缺少文件：${requestedPath}`);
};

const gunzip = async (compressed: Uint8Array): Promise<Uint8Array> => {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 gzip 解压，无法从 NPM Registry 加载 Typst 资源');
  }
  const stream = new Blob([ownedBuffer(compressed)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const loadArchive = (url: string): Promise<Uint8Array> => {
  const existing = archiveCache.get(url);
  if (existing) return existing;

  const task = (async () => {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error(`NPM 包请求失败（${response.status}）：${url}`);
    return gunzip(new Uint8Array(await response.arrayBuffer()));
  })();
  archiveCache.set(url, task);
  task.catch(() => archiveCache.delete(url));
  return task;
};

export const runtimeAssetKey = (asset: TypstRuntimeAssetLocation): string =>
  asset.archivePath ? `${asset.url}#${encodeURIComponent(asset.archivePath)}` : asset.url;

export const loadRuntimeAssetBytes = async (
  asset: TypstRuntimeAssetLocation,
): Promise<Uint8Array> => {
  if (!asset.archivePath) {
    const response = await fetch(asset.url, { mode: 'cors' });
    if (!response.ok) throw new Error(`Typst 资源请求失败（${response.status}）：${asset.url}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return extractTarEntry(await loadArchive(asset.url), asset.archivePath);
};

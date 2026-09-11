import type { TypstRuntimeAssetLocation } from './model';

const TAR_BLOCK_SIZE = 512;
const RUNTIME_CACHE_PREFIX = 'feishu-typst-runtime-';
export const RUNTIME_CACHE_NAME = `${RUNTIME_CACHE_PREFIX}v1`;

interface LoadedBytes {
  bytes: Uint8Array;
  fromPersistentCache: boolean;
}

class CachedPayloadError extends Error {
  constructor(readonly reason: unknown) {
    super('缓存的 Typst 资源无效');
    this.name = 'CachedPayloadError';
  }
}

const archiveCache = new Map<string, Promise<LoadedBytes>>();
const runtimeAssetCache = new Map<string, Promise<Uint8Array>>();
let runtimeCachePromise: Promise<Cache | undefined> | undefined;
let cacheFailureReported = false;

export interface RuntimeDownloadProgress {
  active: boolean;
  loadedBytes: number;
  totalBytes?: number;
  fileCount: number;
}

interface ActiveDownload {
  loadedBytes: number;
  totalBytes?: number;
}

export interface ProgressDownloadOptions {
  errorLabel: string;
  maximumBytes?: number;
  maximumError?: string;
}

const activeDownloads = new Map<number, ActiveDownload>();
const progressListeners = new Set<(progress: RuntimeDownloadProgress) => void>();
let nextDownloadId = 0;

const downloadProgress = (): RuntimeDownloadProgress => {
  const downloads = Array.from(activeDownloads.values());
  const allTotalsKnown = downloads.every((download) => download.totalBytes !== undefined);
  return {
    active: downloads.length > 0,
    loadedBytes: downloads.reduce((total, download) => total + download.loadedBytes, 0),
    totalBytes: allTotalsKnown
      ? downloads.reduce((total, download) => total + (download.totalBytes ?? 0), 0)
      : undefined,
    fileCount: downloads.length,
  };
};

const notifyDownloadProgress = () => {
  const progress = downloadProgress();
  progressListeners.forEach((listener) => {
    try {
      listener(progress);
    } catch (reason) {
      console.error('Typst 下载进度监听器执行失败', reason);
    }
  });
};

export const subscribeRuntimeDownloadProgress = (
  listener: (progress: RuntimeDownloadProgress) => void,
): (() => void) => {
  progressListeners.add(listener);
  try {
    listener(downloadProgress());
  } catch (reason) {
    console.error('Typst 下载进度监听器执行失败', reason);
  }
  return () => progressListeners.delete(listener);
};

const reportCacheFailure = (operation: string, reason: unknown) => {
  if (cacheFailureReported) return;
  cacheFailureReported = true;
  console.info(`Typst Cache Storage ${operation}失败，已回退到网络加载。`, reason);
};

const openRuntimeCache = (): Promise<Cache | undefined> => {
  if (runtimeCachePromise) return runtimeCachePromise;
  if (!('caches' in globalThis)) return Promise.resolve(undefined);

  runtimeCachePromise = (async () => {
    const storage = globalThis.caches;
    const cache = await storage.open(RUNTIME_CACHE_NAME);

    try {
      const names = await storage.keys();
      await Promise.allSettled(
        names
          .filter((name) => name.startsWith(RUNTIME_CACHE_PREFIX) && name !== RUNTIME_CACHE_NAME)
          .map((name) => storage.delete(name)),
      );
    } catch (reason) {
      reportCacheFailure('清理旧版本', reason);
    }

    return cache;
  })().catch((reason) => {
    reportCacheFailure('初始化', reason);
    return undefined;
  });
  return runtimeCachePromise;
};

const runtimeRequest = (url: string) =>
  new Request(url, { method: 'GET', mode: 'cors', credentials: 'omit' });

const deleteCachedResponse = async (url: string): Promise<void> => {
  const cache = await openRuntimeCache();
  if (!cache) return;
  try {
    await cache.delete(runtimeRequest(url));
  } catch (reason) {
    reportCacheFailure('删除损坏内容', reason);
  }
};

const readCachedBytes = async (url: string): Promise<Uint8Array | undefined> => {
  const cache = await openRuntimeCache();
  if (!cache) return undefined;

  try {
    const response = await cache.match(runtimeRequest(url));
    if (!response) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Do not compare Content-Length here. Cache Storage may expose a decoded
    // body while retaining the transfer-time Content-Encoding/Length headers.
    if (!response.ok || !bytes.byteLength) {
      await deleteCachedResponse(url);
      return undefined;
    }
    return bytes;
  } catch (reason) {
    reportCacheFailure('读取', reason);
    await deleteCachedResponse(url);
    return undefined;
  }
};

const storeResponse = async (url: string, response: Response): Promise<void> => {
  const cache = await openRuntimeCache();
  if (!cache) return;
  try {
    await cache.put(runtimeRequest(url), response);
  } catch (reason) {
    // QuotaExceededError, SecurityError and private-mode failures must never
    // prevent the successfully downloaded runtime resource from being used.
    reportCacheFailure('写入', reason);
  }
};

const fetchNetworkBytesWithProgress = async (
  url: string,
  options: ProgressDownloadOptions,
  handleResponse?: (response: Response) => Promise<void>,
): Promise<Uint8Array> => {
  const downloadId = ++nextDownloadId;
  activeDownloads.set(downloadId, { loadedBytes: 0 });
  notifyDownloadProgress();

  try {
    const response = await fetch(runtimeRequest(url));
    if (!response.ok) throw new Error(`${options.errorLabel}（${response.status}）：${url}`);
    const responseTask = handleResponse?.(response.clone());

    const contentLength = Number(response.headers.get('content-length'));
    if (
      options.maximumBytes !== undefined &&
      Number.isFinite(contentLength) &&
      contentLength > options.maximumBytes
    ) {
      throw new Error(options.maximumError ?? `${options.errorLabel}超过大小上限`);
    }
    const current = activeDownloads.get(downloadId);
    if (current && Number.isFinite(contentLength) && contentLength > 0) {
      current.totalBytes = contentLength;
      notifyDownloadProgress();
    }

    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (options.maximumBytes !== undefined && bytes.byteLength > options.maximumBytes) {
        throw new Error(options.maximumError ?? `${options.errorLabel}超过大小上限`);
      }
      activeDownloads.set(downloadId, { loadedBytes: bytes.byteLength, totalBytes: bytes.byteLength });
      notifyDownloadProgress();
      await responseTask;
      return bytes;
    }

    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let loadedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loadedBytes += value.byteLength;
      if (options.maximumBytes !== undefined && loadedBytes > options.maximumBytes) {
        await reader.cancel();
        throw new Error(options.maximumError ?? `${options.errorLabel}超过大小上限`);
      }
      const download = activeDownloads.get(downloadId);
      if (download) {
        download.loadedBytes = loadedBytes;
        if (download.totalBytes !== undefined && loadedBytes > download.totalBytes) {
          download.totalBytes = loadedBytes;
        }
        notifyDownloadProgress();
      }
    }

    const bytes = new Uint8Array(loadedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await responseTask;
    return bytes;
  } finally {
    activeDownloads.delete(downloadId);
    notifyDownloadProgress();
  }
};

export const downloadBytesWithProgress = (
  url: string,
  options: ProgressDownloadOptions,
): Promise<Uint8Array> => fetchNetworkBytesWithProgress(url, options);

const fetchBytes = async (
  url: string,
  errorLabel: string,
  forceNetwork = false,
): Promise<LoadedBytes> => {
  if (!forceNetwork) {
    const cached = await readCachedBytes(url);
    if (cached) return { bytes: cached, fromPersistentCache: true };
  }

  const bytes = await fetchNetworkBytesWithProgress(
    url,
    { errorLabel },
    (response) => storeResponse(url, response),
  );
  return { bytes, fromPersistentCache: false };
};

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

const loadArchive = (url: string, forceNetwork = false): Promise<LoadedBytes> => {
  if (forceNetwork) {
    const existing = archiveCache.get(url);
    if (existing) return existing;

    const retry = (async () => {
      const loaded = await fetchBytes(url, 'NPM 包请求失败', true);
      try {
        return { ...loaded, bytes: await gunzip(loaded.bytes) };
      } catch (reason) {
        await deleteCachedResponse(url);
        throw reason;
      }
    })();
    archiveCache.set(url, retry);
    retry.catch(() => {
      if (archiveCache.get(url) === retry) archiveCache.delete(url);
    });
    return retry;
  }

  const existing = archiveCache.get(url);
  if (existing) return existing;

  const task = (async () => {
    const loaded = await fetchBytes(url, 'NPM 包请求失败');
    try {
      return { ...loaded, bytes: await gunzip(loaded.bytes) };
    } catch (reason) {
      if (loaded.fromPersistentCache) throw new CachedPayloadError(reason);
      await deleteCachedResponse(url);
      throw reason;
    }
  })();
  archiveCache.set(url, task);
  task.catch(() => {
    if (archiveCache.get(url) === task) archiveCache.delete(url);
  });
  return task;
};

export const runtimeAssetKey = (asset: TypstRuntimeAssetLocation): string =>
  asset.archivePath ? `${asset.url}#${encodeURIComponent(asset.archivePath)}` : asset.url;

const validatesAssetSignature = (asset: TypstRuntimeAssetLocation, bytes: Uint8Array): boolean => {
  const pathname = (asset.archivePath ?? new URL(asset.url).pathname).toLowerCase();
  if (pathname.endsWith('.wasm')) {
    return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 97 && bytes[2] === 115 && bytes[3] === 109;
  }
  if (/\.(?:otf|ttf|ttc|woff)$/.test(pathname)) {
    if (bytes.length < 4) return false;
    const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    return (
      signature === 'OTTO' ||
      signature === 'ttcf' ||
      signature === 'true' ||
      signature === 'typ1' ||
      signature === 'wOFF' ||
      (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
    );
  }
  return bytes.byteLength > 0;
};

const loadRuntimeAssetOnce = async (
  asset: TypstRuntimeAssetLocation,
  forceNetwork = false,
): Promise<LoadedBytes> => {
  if (!asset.archivePath) {
    const loaded = await fetchBytes(asset.url, 'Typst 资源请求失败', forceNetwork);
    if (!validatesAssetSignature(asset, loaded.bytes)) {
      if (loaded.fromPersistentCache) throw new CachedPayloadError('文件签名无效');
      await deleteCachedResponse(asset.url);
      throw new Error(`Typst 资源格式无效：${asset.url}`);
    }
    return loaded;
  }

  const archive = await loadArchive(asset.url, forceNetwork);
  try {
    const bytes = extractTarEntry(archive.bytes, asset.archivePath);
    if (!validatesAssetSignature(asset, bytes)) {
      throw new Error(`npm 包中的 Typst 资源格式无效：${asset.archivePath}`);
    }
    return { ...archive, bytes };
  } catch (reason) {
    if (archive.fromPersistentCache) throw new CachedPayloadError(reason);
    await deleteCachedResponse(asset.url);
    throw reason;
  }
};

const loadRuntimeAssetWithRecovery = async (
  asset: TypstRuntimeAssetLocation,
): Promise<Uint8Array> => {
  try {
    return (await loadRuntimeAssetOnce(asset)).bytes;
  } catch (reason) {
    if (!(reason instanceof CachedPayloadError)) throw reason;
    archiveCache.delete(asset.url);
    await deleteCachedResponse(asset.url);
    return (await loadRuntimeAssetOnce(asset, true)).bytes;
  }
};

export const loadRuntimeAssetBytes = (
  asset: TypstRuntimeAssetLocation,
): Promise<Uint8Array> => {
  const key = runtimeAssetKey(asset);
  const existing = runtimeAssetCache.get(key);
  if (existing) return existing;

  const task = loadRuntimeAssetWithRecovery(asset);
  runtimeAssetCache.set(key, task);
  task.catch(() => {
    if (runtimeAssetCache.get(key) === task) runtimeAssetCache.delete(key);
  });
  return task;
};

/** Release large in-memory buffers when an iframe is really being destroyed. */
export const resetRuntimeAssetLoaderState = (): void => {
  archiveCache.clear();
  runtimeAssetCache.clear();
  runtimeCachePromise = undefined;
  cacheFailureReported = false;
};

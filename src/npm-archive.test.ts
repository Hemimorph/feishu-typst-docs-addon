import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTypstRuntimeAssetUrls } from './model';
import {
  RUNTIME_CACHE_NAME,
  extractTarEntry,
  loadRuntimeAssetBytes,
  resetRuntimeAssetLoaderState,
  runtimeAssetKey,
  subscribeRuntimeDownloadProgress,
  type RuntimeDownloadProgress,
} from './npm-archive';

afterEach(() => {
  resetRuntimeAssetLoaderState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const wasmBytes = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const byteResponse = (bytes: Uint8Array) => new Response(bytes.slice().buffer);

const createCacheStorage = (initial: Record<string, Uint8Array> = {}) => {
  const entries = new Map(
    Object.entries(initial).map(([url, bytes]) => [url, byteResponse(bytes)]),
  );
  const requestUrl = (request: RequestInfo | URL) =>
    request instanceof Request ? request.url : request.toString();
  const cache = {
    match: vi.fn(async (request: RequestInfo | URL) => entries.get(requestUrl(request))?.clone()),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      entries.set(requestUrl(request), response.clone());
    }),
    delete: vi.fn(async (request: RequestInfo | URL) => entries.delete(requestUrl(request))),
  };
  const storage = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => [RUNTIME_CACHE_NAME]),
    delete: vi.fn(async () => true),
  };
  return { cache, entries, storage };
};

const writeText = (target: Uint8Array, offset: number, length: number, value: string) => {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
};

const makeTar = (path: string, content: Uint8Array): Uint8Array => {
  const paddedSize = Math.ceil(content.length / 512) * 512;
  const result = new Uint8Array(512 + paddedSize + 1024);
  writeText(result, 0, 100, path);
  writeText(result, 124, 12, `${content.length.toString(8).padStart(11, '0')}\0`);
  result[156] = '0'.charCodeAt(0);
  result.set(content, 512);
  return result;
};

describe('extractTarEntry', () => {
  it('reads a regular npm package entry', () => {
    const content = new TextEncoder().encode('typst wasm');
    const tar = makeTar('package/pkg/module.wasm', content);
    expect(new TextDecoder().decode(extractTarEntry(tar, 'package/pkg/module.wasm'))).toBe(
      'typst wasm',
    );
  });

  it('rejects missing entries', () => {
    expect(() => extractTarEntry(makeTar('package/a', new Uint8Array([1])), 'package/b')).toThrow(
      'npm 包中缺少文件',
    );
  });
});

describe('runtimeAssetKey', () => {
  it('keeps archive entries distinct when they share a tarball', () => {
    expect(runtimeAssetKey({ url: 'https://registry/pkg.tgz', archivePath: 'package/a.otf' }))
      .not.toBe(runtimeAssetKey({ url: 'https://registry/pkg.tgz', archivePath: 'package/b.otf' }));
  });
});

describe('runtime download progress', () => {
  it('reports streamed bytes and returns to an inactive state', async () => {
    const snapshots: RuntimeDownloadProgress[] = [];
    const unsubscribe = subscribeRuntimeDownloadProgress((progress) => snapshots.push(progress));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-length': '4' },
        }),
      ),
    );

    await expect(loadRuntimeAssetBytes({ url: 'https://example.com/progress.bin' })).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    unsubscribe();

    expect(snapshots.some((progress) => progress.active && progress.totalBytes === 4)).toBe(true);
    expect(snapshots.some((progress) => progress.loadedBytes === 4)).toBe(true);
    expect(snapshots[snapshots.length - 1].active).toBe(false);
  });
});

describe('runtime Cache Storage', () => {
  it('deduplicates concurrent downloads and reuses verified bytes after memory is released', async () => {
    const url = 'https://example.com/compiler.wasm';
    const { cache, storage } = createCacheStorage();
    const fetchMock = vi.fn(async () => byteResponse(wasmBytes()));
    vi.stubGlobal('caches', storage);
    vi.stubGlobal('fetch', fetchMock);

    const [first, concurrent] = await Promise.all([
      loadRuntimeAssetBytes({ url }),
      loadRuntimeAssetBytes({ url }),
    ]);
    expect(first).toEqual(wasmBytes());
    expect(concurrent).toEqual(wasmBytes());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);

    resetRuntimeAssetLoaderState();
    await expect(loadRuntimeAssetBytes({ url })).resolves.toEqual(wasmBytes());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.match).toHaveBeenCalled();
  });

  it('evicts a corrupt cached resource and retries it from the network once', async () => {
    const url = 'https://example.com/renderer.wasm';
    const corrupt = new TextEncoder().encode('<html>not wasm</html>');
    const { cache, storage } = createCacheStorage({ [url]: corrupt });
    const fetchMock = vi.fn(async () => byteResponse(wasmBytes()));
    vi.stubGlobal('caches', storage);
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadRuntimeAssetBytes({ url })).resolves.toEqual(wasmBytes());
    expect(cache.delete).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the network when Cache Storage cannot be opened', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.stubGlobal('caches', {
      open: vi.fn(async () => {
        throw new DOMException('denied', 'SecurityError');
      }),
    });
    const fetchMock = vi.fn(async () => byteResponse(wasmBytes()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadRuntimeAssetBytes({ url: 'https://example.com/no-cache.wasm' }),
    ).resolves.toEqual(wasmBytes());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('keeps downloaded bytes usable when a cache write exceeds quota', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { cache, storage } = createCacheStorage();
    cache.put.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    vi.stubGlobal('caches', storage);
    vi.stubGlobal('fetch', vi.fn(async () => byteResponse(wasmBytes())));

    await expect(
      loadRuntimeAssetBytes({ url: 'https://example.com/quota.wasm' }),
    ).resolves.toEqual(wasmBytes());
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('cleans only obsolete caches owned by this add-on', async () => {
    const { storage } = createCacheStorage();
    storage.keys.mockResolvedValueOnce([
      'feishu-typst-runtime-v0',
      RUNTIME_CACHE_NAME,
      'unrelated-cache',
    ]);
    vi.stubGlobal('caches', storage);
    vi.stubGlobal('fetch', vi.fn(async () => byteResponse(wasmBytes())));

    await loadRuntimeAssetBytes({ url: 'https://example.com/cleanup.wasm' });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('feishu-typst-runtime-v0');
  });

  it('does not let an abandoned request evict a newer in-memory entry', async () => {
    const url = 'https://example.com/remounted.wasm';
    let rejectAbandoned!: (reason: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const abandonedResponse = new Promise<Response>((_resolve, reject) => {
      rejectAbandoned = reject;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => {
        markStarted();
        return abandonedResponse;
      })
      .mockImplementation(async () => byteResponse(wasmBytes()));
    vi.stubGlobal('fetch', fetchMock);

    const abandoned = loadRuntimeAssetBytes({ url });
    await started;
    resetRuntimeAssetLoaderState();
    const current = loadRuntimeAssetBytes({ url });
    rejectAbandoned(new Error('old iframe closed'));

    await expect(abandoned).rejects.toThrow('old iframe closed');
    await expect(current).resolves.toEqual(wasmBytes());
    await expect(loadRuntimeAssetBytes({ url })).resolves.toEqual(wasmBytes());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

const registry = process.env.TYPST_REGISTRY_INTEGRATION_URL;
const registryTest = registry ? it : it.skip;

describe('NPM Registry integration', () => {
  registryTest('loads one required resource from every published package', async () => {
    const assets = getTypstRuntimeAssetUrls(registry!, 'npm-registry');
    const compiler = await loadRuntimeAssetBytes(assets.compilerWasm);
    const renderer = await loadRuntimeAssetBytes(assets.rendererWasm);
    const latinFont = await loadRuntimeAssetBytes(assets.fonts[0]);
    const cjkFont = await loadRuntimeAssetBytes(assets.fonts[assets.fonts.length - 1]);

    expect(Array.from(compiler.subarray(0, 4))).toEqual([0, 97, 115, 109]);
    expect(Array.from(renderer.subarray(0, 4))).toEqual([0, 97, 115, 109]);
    expect(new TextDecoder().decode(latinFont.subarray(0, 4))).toBe('OTTO');
    expect(new TextDecoder().decode(cjkFont.subarray(0, 4))).toBe('OTTO');
  }, 120_000);
});

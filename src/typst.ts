import { TypstSnippet } from '@myriaddreamin/typst.ts/contrib/snippet';
import type { TypstSnippetProvider } from '@myriaddreamin/typst.ts/contrib/snippet';
import { base64ToBytes } from './embedded';
import { errorMessage } from './error';
import {
  extractFontFiles,
  fontArchiveCrc32,
} from './font-archive';
import {
  BUILTIN_TYPST_FONTS,
  fontInfoToCatalog,
  mergeFontCatalog,
  type AvailableTypstFont,
} from './fonts';
import { loadNixOutPathFonts } from './nix-fonts';
import {
  isImageAssetReferenced,
  getConfiguredTypstRuntimeAssetUrls,
  normalizeAssetPath,
  type EmbeddedFontAsset,
  type EmbeddedImageAsset,
  type TypstAddonRecord,
  type TypstImageAsset,
} from './model';
import { normalizeFontBytes } from './woff';
import {
  downloadBytesWithProgress,
  loadRuntimeAssetBytes,
  resetRuntimeAssetLoaderState,
  runtimeAssetKey,
} from './npm-archive';
import type { TypstRuntimeAssetLocation } from './model';

const MAIN_FILE = '/project/main.typ';

const byteCache = new Map<string, Promise<Uint8Array>>();
const fontByteCache = new Map<string, Promise<Uint8Array>>();
interface LoadedFont {
  source: string;
  bytes: Uint8Array;
}
const fontSourceCache = new Map<string, Promise<LoadedFont[]>>();

const loadRemoteBytes = (url: string): Promise<Uint8Array> => {
  const cacheKey = `remote:${url}`;
  const existing = byteCache.get(cacheKey);
  if (existing) return existing;

  const task = (async () => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error(`远程图片只支持 HTTPS：${url}`);
    }
    const response = await fetch(parsed.toString(), { mode: 'cors' });
    if (!response.ok) {
      throw new Error(`远程图片请求失败（${response.status}）：${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  })();

  byteCache.set(cacheKey, task);
  task.catch(() => {
    if (byteCache.get(cacheKey) === task) byteCache.delete(cacheKey);
  });
  return task;
};

const loadFeishuBytes = (asset: Extract<TypstImageAsset, { source: 'feishu' }>) => {
  const cacheKey = `feishu:${asset.docToken}:${asset.blockId}`;
  const existing = byteCache.get(cacheKey);
  if (existing) return existing;

  const task = (async () => {
    const { docsApi } = await import('./feishu');
    const docRef = docsApi.getDocumentRefById(asset.docToken);
    const blockRef = docsApi.getBlockRefById(docRef, asset.blockId);
    const blob = await docsApi.Block.ImageBlock.getImageData(blockRef);
    return new Uint8Array(await blob.arrayBuffer());
  })();

  byteCache.set(cacheKey, task);
  task.catch(() => {
    if (byteCache.get(cacheKey) === task) byteCache.delete(cacheKey);
  });
  return task;
};

const loadImageBytes = (asset: TypstImageAsset): Promise<Uint8Array> =>
  asset.source === 'remote'
    ? loadRemoteBytes(asset.url)
    : asset.source === 'embedded'
      ? loadEmbeddedImageBytes(asset)
      : loadFeishuBytes(asset);

const loadEmbeddedImageBytes = (asset: EmbeddedImageAsset): Promise<Uint8Array> => {
  const cacheKey = `embedded-image:${asset.sha256}`;
  const existing = byteCache.get(cacheKey);
  if (existing) return existing;
  const task = Promise.resolve(base64ToBytes(asset.data));
  byteCache.set(cacheKey, task);
  return task;
};

const loadFontSource = (source: string): Promise<LoadedFont[]> => {
  const existing = fontSourceCache.get(source);
  if (existing) return existing;

  const task = (async () => {
    if (source.trim().startsWith('/nix/store/')) {
      const files = await loadNixOutPathFonts(source);
      return Promise.all(
        files.map(async (file) => ({
          source: `${source.trim()}#${encodeURIComponent(file.path)}`,
          bytes: await normalizeFontBytes(file.bytes),
        })),
      );
    }

    const url = source;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error(`字体只支持 HTTPS URL：${url}`);
    }
    const downloaded = await downloadBytesWithProgress(parsed.toString(), {
      errorLabel: '字体请求失败',
    });
    const files = await extractFontFiles(downloaded, url);
    return Promise.all(
      files.map(async (file) => ({
        source: files.length === 1 ? url : `${url}#${encodeURIComponent(file.path)}`,
        bytes: await normalizeFontBytes(file.bytes),
      })),
    );
  })();

  fontSourceCache.set(source, task);
  task.catch(() => {
    if (fontSourceCache.get(source) === task) fontSourceCache.delete(source);
  });
  return task;
};

const embeddedFontKey = (font: EmbeddedFontAsset) => `embedded-font:${font.id}`;

const loadEmbeddedFontBytes = (font: EmbeddedFontAsset): Promise<Uint8Array> => {
  const cacheKey = `embedded-font:${font.sha256}`;
  const existing = fontByteCache.get(cacheKey);
  if (existing) return existing;
  const task = normalizeFontBytes(base64ToBytes(font.data));
  fontByteCache.set(cacheKey, task);
  task.catch(() => {
    if (fontByteCache.get(cacheKey) === task) fontByteCache.delete(cacheKey);
  });
  return task;
};

const preloadNormalizedFonts = (
  builtInFonts: TypstRuntimeAssetLocation[],
  urls: string[],
  embeddedFonts: EmbeddedFontAsset[],
): TypstSnippetProvider => {
  return {
    key: 'feishu-normalized-fonts',
    forRoles: ['compiler'],
    provides: [
      async (_stage, { builder }) => {
        const [builtInGroups, remoteGroups, embeddedGroups] = await Promise.all([
          Promise.all(
            builtInFonts.map(async (font) => [
              {
                source: runtimeAssetKey(font),
                bytes: await normalizeFontBytes(await loadRuntimeAssetBytes(font)),
              },
            ]),
          ),
          Promise.all(urls.map(loadFontSource)),
          Promise.all(
            embeddedFonts.map(async (font) => [
              { source: embeddedFontKey(font), bytes: await loadEmbeddedFontBytes(font) },
            ]),
          ),
        ]);
        const loaded = [...builtInGroups, ...remoteGroups, ...embeddedGroups].flat();
        const seen = new Set<string>();
        for (const font of loaded) {
          const fingerprint = `${font.bytes.byteLength}:${fontArchiveCrc32(font.bytes)}`;
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          await builder.add_raw_font(font.bytes);
        }
      },
    ],
  };
};

class TypstRuntime {
  private snippet: TypstSnippet;
  private queue: Promise<unknown> = Promise.resolve();
  private fontCatalog?: Promise<AvailableTypstFont[]>;

  constructor(
    private readonly fonts: string[],
    private readonly embeddedFonts: EmbeddedFontAsset[],
  ) {
    const assets = getConfiguredTypstRuntimeAssetUrls();
    this.snippet = new TypstSnippet();
    this.snippet.setCompilerInitOptions({
      getModule: () => loadRuntimeAssetBytes(assets.compilerWasm),
    });
    this.snippet.setRendererInitOptions({
      getModule: () => loadRuntimeAssetBytes(assets.rendererWasm),
    });
    this.snippet.setMainFilePath(MAIN_FILE);
    this.snippet.use(preloadNormalizedFonts(assets.fonts, fonts, embeddedFonts));
  }

  private run<T>(record: TypstAddonRecord, produce: () => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      await this.snippet.resetShadow();
      await this.snippet.addSource(MAIN_FILE, record.source);

      for (const asset of record.images) {
        try {
          const relativePath = normalizeAssetPath(asset.path);
          // Resources listed in the editor are not necessarily used yet. Avoid
          // downloading them until a literal assets/... path appears in source;
          // otherwise one unavailable candidate can break an unrelated preview.
          if (!isImageAssetReferenced(record.source, relativePath)) continue;
          const bytes = await loadImageBytes(asset);
          await this.snippet.mapShadow(`/project/assets/${relativePath}`, bytes);
        } catch (error) {
          const detail = errorMessage(error);
          if (asset.source === 'feishu' && /API not implemented|getImageData/i.test(detail)) {
            throw new Error(
              `图片 ${asset.path} 无法读取：当前飞书客户端尚未实现文档图片数据接口。` +
                '请移除该资源，改用可跨域访问的 HTTPS 图片 URL。',
            );
          }
          throw new Error(`图片 ${asset.path} 加载失败：${detail}`);
        }
      }

      return produce();
    });

    this.queue = work.catch(() => undefined);
    return work;
  }

  render(record: TypstAddonRecord): Promise<string> {
    return this.run(record, async () => {
      const svg = await this.snippet.svg({ mainFilePath: MAIN_FILE });
      if (!svg) throw new Error('Typst 未生成预览结果');
      return svg;
    });
  }

  pdf(record: TypstAddonRecord): Promise<Uint8Array> {
    return this.run(record, async () => {
      const pdf = await this.snippet.pdf({ mainFilePath: MAIN_FILE });
      if (!pdf?.length) throw new Error('Typst 未生成 PDF');
      return pdf;
    });
  }

  availableFonts(): Promise<AvailableTypstFont[]> {
    if (!this.fonts.length && !this.embeddedFonts.length) {
      return Promise.resolve(mergeFontCatalog(BUILTIN_TYPST_FONTS));
    }
    if (this.fontCatalog) return this.fontCatalog;

    this.fontCatalog = (async () => {
      // Initializing the compiler first verifies that every configured font is
      // genuinely accepted by the same runtime used for preview and PDF.
      await this.snippet.getCompiler();
      const resolver = await this.snippet.getFontResolver();
      const customFonts: AvailableTypstFont[] = [];

      for (const source of this.fonts) {
        try {
          const files = await loadFontSource(source);
          const catalogs = await Promise.all(
            files.map(async (font) => {
              const info = await resolver.getFontInfo(font.bytes);
              return fontInfoToCatalog(info, font.source);
            }),
          );
          const parsed = catalogs.flat();
          if (!parsed.length) throw new Error('资源中没有可识别的字体字族');
          customFonts.push(...parsed);
        } catch (reason) {
          throw new Error(`字体 ${source} 加载失败：${errorMessage(reason)}`);
        }
      }

      for (const font of this.embeddedFonts) {
        try {
          const bytes = await loadEmbeddedFontBytes(font);
          const info = await resolver.getFontInfo(bytes);
          const parsed = fontInfoToCatalog(info, `嵌入：${font.name}`);
          if (!parsed.length) throw new Error('文件中没有可识别的字体字族');
          customFonts.push(...parsed);
        } catch (reason) {
          throw new Error(`嵌入字体 ${font.name} 加载失败：${errorMessage(reason)}`);
        }
      }

      return mergeFontCatalog(BUILTIN_TYPST_FONTS, customFonts);
    })();
    this.fontCatalog.catch(() => {
      this.fontCatalog = undefined;
    });
    return this.fontCatalog;
  }
}

let runtimeKey = '';
let runtime: TypstRuntime | undefined;

const getRuntime = (record: TypstAddonRecord): TypstRuntime => {
  const nextKey = JSON.stringify([
    record.fonts,
    record.embeddedFonts.map((font) => [font.id, font.sha256, font.size]),
  ]);
  if (!runtime || runtimeKey !== nextKey) {
    runtimeKey = nextKey;
    runtime = new TypstRuntime(record.fonts, record.embeddedFonts);
  }
  return runtime;
};

export const renderTypst = async (record: TypstAddonRecord): Promise<string> => {
  return getRuntime(record).render(record);
};

export const renderTypstPdf = async (record: TypstAddonRecord): Promise<Uint8Array> => {
  return getRuntime(record).pdf(record);
};

export const getAvailableTypstFonts = async (
  record: TypstAddonRecord,
): Promise<AvailableTypstFont[]> => getRuntime(record).availableFonts();

/**
 * Drop only process-local resources. Cache Storage remains intact so a newly
 * mounted iframe can reuse the verified downloads without another request.
 */
export const disposeTypstRuntime = (): void => {
  runtimeKey = '';
  runtime = undefined;
  byteCache.clear();
  fontByteCache.clear();
  fontSourceCache.clear();
  resetRuntimeAssetLoaderState();
};

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    // A page entering the back/forward cache is still alive and may resume.
    if (!(event as PageTransitionEvent).persisted) disposeTypstRuntime();
  });
}

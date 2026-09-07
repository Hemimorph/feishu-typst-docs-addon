import { loadFonts } from '@myriaddreamin/typst.ts';
import { TypstSnippet } from '@myriaddreamin/typst.ts/contrib/snippet';
import type { TypstSnippetProvider } from '@myriaddreamin/typst.ts/contrib/snippet';
import { base64ToBytes } from './embedded';
import { errorMessage } from './error';
import {
  BUILTIN_TYPST_FONTS,
  fontInfoToCatalog,
  mergeFontCatalog,
  type AvailableTypstFont,
} from './fonts';
import {
  isImageAssetReferenced,
  normalizeAssetPath,
  type EmbeddedFontAsset,
  type EmbeddedImageAsset,
  type TypstAddonRecord,
  type TypstImageAsset,
} from './model';
import { normalizeFontBytes } from './woff';

const COMPILER_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm';
const RENDERER_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.7.0/pkg/typst_ts_renderer_bg.wasm';
const MAIN_FILE = '/project/main.typ';

const byteCache = new Map<string, Promise<Uint8Array>>();
const fontByteCache = new Map<string, Promise<Uint8Array>>();

const loadRemoteBytes = (url: string): Promise<Uint8Array> => {
  const existing = byteCache.get(`remote:${url}`);
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

  byteCache.set(`remote:${url}`, task);
  task.catch(() => byteCache.delete(`remote:${url}`));
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
  task.catch(() => byteCache.delete(cacheKey));
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

const loadFontBytes = (url: string): Promise<Uint8Array> => {
  const existing = fontByteCache.get(url);
  if (existing) return existing;

  const task = (async () => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error(`字体只支持 HTTPS URL：${url}`);
    }
    const response = await fetch(parsed.toString(), { mode: 'cors' });
    if (!response.ok) {
      throw new Error(`字体请求失败（${response.status}）：${url}`);
    }
    return normalizeFontBytes(new Uint8Array(await response.arrayBuffer()));
  })();

  fontByteCache.set(url, task);
  task.catch(() => fontByteCache.delete(url));
  return task;
};

const embeddedFontKey = (font: EmbeddedFontAsset) => `embedded-font:${font.id}`;

const loadEmbeddedFontBytes = (font: EmbeddedFontAsset): Promise<Uint8Array> => {
  const cacheKey = `embedded-font:${font.sha256}`;
  const existing = fontByteCache.get(cacheKey);
  if (existing) return existing;
  const task = normalizeFontBytes(base64ToBytes(font.data));
  fontByteCache.set(cacheKey, task);
  task.catch(() => fontByteCache.delete(cacheKey));
  return task;
};

const preloadNormalizedFonts = (
  urls: string[],
  embeddedFonts: EmbeddedFontAsset[],
): TypstSnippetProvider => {
  const embeddedByKey = new Map(embeddedFonts.map((font) => [embeddedFontKey(font), font]));
  return {
    key: 'feishu-normalized-fonts',
    forRoles: ['compiler'],
    provides: [
      loadFonts([...urls, ...embeddedByKey.keys()], {
        assets: false,
        fetcher: async (input) => {
          const source =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          const embedded = embeddedByKey.get(source);
          const bytes = embedded
            ? await loadEmbeddedFontBytes(embedded)
            : await loadFontBytes(source);
          return new Response(bytes.slice().buffer);
        },
      }),
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
    this.snippet = new TypstSnippet();
    this.snippet.setCompilerInitOptions({ getModule: () => COMPILER_WASM_URL });
    this.snippet.setRendererInitOptions({ getModule: () => RENDERER_WASM_URL });
    this.snippet.setMainFilePath(MAIN_FILE);
    this.snippet.use(TypstSnippet.preloadFontAssets({ assets: ['text', 'cjk'] }));
    if (fonts.length || embeddedFonts.length) {
      this.snippet.use(preloadNormalizedFonts(fonts, embeddedFonts));
    }
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

      for (const url of this.fonts) {
        try {
          const bytes = await loadFontBytes(url);
          const info = await resolver.getFontInfo(bytes);
          const parsed = fontInfoToCatalog(info, url);
          if (!parsed.length) throw new Error('文件中没有可识别的字体字族');
          customFonts.push(...parsed);
        } catch (reason) {
          throw new Error(`字体 ${url} 加载失败：${errorMessage(reason)}`);
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

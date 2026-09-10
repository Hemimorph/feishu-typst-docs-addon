export interface RemoteImageAsset {
  id: string;
  source: 'remote';
  path: string;
  url: string;
}

export interface FeishuImageAsset {
  id: string;
  source: 'feishu';
  path: string;
  docToken: string;
  blockId: number;
  imageToken?: string;
}

export interface EmbeddedImageAsset {
  id: string;
  source: 'embedded';
  path: string;
  name: string;
  mime: string;
  size: number;
  data: string;
  sha256: string;
}

export interface EmbeddedFontAsset {
  id: string;
  name: string;
  mime: string;
  size: number;
  data: string;
  sha256: string;
}

export type TypstImageAsset = RemoteImageAsset | FeishuImageAsset | EmbeddedImageAsset;

declare const __TYPST_RESOURCE_MIRROR__: string;
declare const __TYPST_RESOURCE_MIRROR_MODE__: TypstResourceMirrorMode;

export type TypstResourceMirrorMode = 'npm-cdn' | 'npm-registry';

export const normalizeResourceMirror = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 HTTPS 资源镜像基址');
  }
  if (parsed.protocol !== 'https:') throw new Error('资源镜像基址只支持 HTTPS');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('资源镜像基址不能包含账号、查询参数或片段');
  }
  return parsed.toString().replace(/\/+$/, '');
};

export interface TypstRuntimeAssetLocation {
  url: string;
  archivePath?: string;
}

export interface TypstRuntimeAssetUrls {
  compilerWasm: TypstRuntimeAssetLocation;
  rendererWasm: TypstRuntimeAssetLocation;
  fonts: TypstRuntimeAssetLocation[];
}

/** Resolve every built-in runtime request from an npm file CDN or NPM Registry. */
export const getTypstRuntimeAssetUrls = (
  mirror: string,
  mode: TypstResourceMirrorMode = 'npm-cdn',
): TypstRuntimeAssetUrls => {
  const base = normalizeResourceMirror(mirror);
  const packageAsset = (
    packageName: string,
    version: string,
    file: string,
  ): TypstRuntimeAssetLocation => {
    if (mode === 'npm-registry') {
      const tarballName = packageName.split('/').pop();
      return {
        url: `${base}/${packageName}/-/${tarballName}-${version}.tgz`,
        archivePath: `package/${file}`,
      };
    }
    return { url: `${base}/${packageName}@${version}/${file}` };
  };
  const typstFont = (file: string) =>
    packageAsset('@typst-wasm/fonts', '1.0.0', `dist/files/${file}`);
  return {
    compilerWasm: packageAsset(
      '@myriaddreamin/typst-ts-web-compiler',
      '0.7.0',
      'pkg/typst_ts_web_compiler_bg.wasm',
    ),
    rendererWasm: packageAsset(
      '@myriaddreamin/typst-ts-renderer',
      '0.7.0',
      'pkg/typst_ts_renderer_bg.wasm',
    ),
    fonts: [
      'LibertinusSerif-Regular.otf',
      'LibertinusSerif-Semibold.otf',
      'LibertinusSerif-Bold.otf',
      'LibertinusSerif-Italic.otf',
      'LibertinusSerif-SemiboldItalic.otf',
      'LibertinusSerif-BoldItalic.otf',
      'NewCM10-Regular.otf',
      'NewCM10-Bold.otf',
      'NewCM10-Italic.otf',
      'NewCM10-BoldItalic.otf',
      'NewCMMath-Regular.otf',
      'NewCMMath-Book.otf',
      'NewCMMath-Bold.otf',
      'DejaVuSansMono.ttf',
      'DejaVuSansMono-Bold.ttf',
      'DejaVuSansMono-Oblique.ttf',
      'DejaVuSansMono-BoldOblique.ttf',
    ].map(typstFont).concat(
      packageAsset(
        '@betteroffice/fonts-cjk',
        '0.1.0',
        'assets/NotoSerifSC-Regular.otf',
      ),
    ),
  };
};

export const getConfiguredTypstRuntimeAssetUrls = (): TypstRuntimeAssetUrls =>
  getTypstRuntimeAssetUrls(__TYPST_RESOURCE_MIRROR__, __TYPST_RESOURCE_MIRROR_MODE__);

export interface TypstAddonRecord {
  schemaVersion: 1;
  version: number;
  source: string;
  fonts: string[];
  embeddedFonts: EmbeddedFontAsset[];
  images: TypstImageAsset[];
}

export const DEFAULT_SOURCE = `#set page(paper: "a4", margin: 1.2cm)
#set text(
  font: ("Noto Serif SC", "Libertinus Serif"),
  lang: "zh",
  size: 12pt,
)

= Typst 已就绪

在飞书云文档中编辑 Typst，并实时查看排版结果。

$ integral_0^infinity e^(-x^2) dif x = sqrt(pi) / 2 $
`;

export const DEFAULT_RECORD: TypstAddonRecord = {
  schemaVersion: 1,
  version: 0,
  source: DEFAULT_SOURCE,
  fonts: [],
  embeddedFonts: [],
  images: [],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const normalizeAssetPath = (value: string): string => {
  const normalized = value.trim().replace(/^assets\//, '');
  const segments = normalized.split('/');

  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('图片路径必须是 assets/ 下的安全相对路径');
  }

  return normalized;
};

export const normalizeImageAssets = (images: TypstImageAsset[]): TypstImageAsset[] => {
  const usedPaths = new Set<string>();

  return images.map((image) => {
    const path = normalizeAssetPath(image.path);
    if (usedPaths.has(path)) {
      throw new Error(`图片资源路径重复：assets/${path}`);
    }
    usedPaths.add(path);
    return { ...image, path };
  });
};

export const isImageAssetReferenced = (source: string, path: string): boolean =>
  source.includes(`assets/${normalizeAssetPath(path)}`);

export const typstRenderKey = (record: TypstAddonRecord): string =>
  JSON.stringify({
    source: record.source,
    fonts: record.fonts,
    embeddedFonts: record.embeddedFonts.map((font) => [font.id, font.sha256, font.size]),
    images: record.images.map((image) => {
      if (image.source === 'remote') return [image.id, image.source, image.path, image.url];
      if (image.source === 'embedded') {
        return [image.id, image.source, image.path, image.sha256, image.size];
      }
      return [image.id, image.source, image.path, image.docToken, image.blockId, image.imageToken];
    }),
  });

export const normalizeRecord = (value: unknown): TypstAddonRecord => {
  if (!isObject(value) || value.schemaVersion !== 1) {
    return { ...DEFAULT_RECORD };
  }

  const fonts = Array.isArray(value.fonts)
    ? value.fonts.filter((font): font is string => typeof font === 'string')
    : [];
  const embeddedFonts = Array.isArray(value.embeddedFonts)
    ? value.embeddedFonts.filter((font): font is EmbeddedFontAsset => {
        if (!isObject(font)) return false;
        return (
          typeof font.id === 'string' &&
          typeof font.name === 'string' &&
          typeof font.mime === 'string' &&
          typeof font.size === 'number' &&
          typeof font.data === 'string' &&
          typeof font.sha256 === 'string'
        );
      })
    : [];
  const images = Array.isArray(value.images)
    ? value.images.filter((image): image is TypstImageAsset => {
        if (!isObject(image)) return false;
        if (
          typeof image.id !== 'string' ||
          typeof image.path !== 'string' ||
          (image.source !== 'remote' && image.source !== 'feishu' && image.source !== 'embedded')
        ) {
          return false;
        }
        if (image.source === 'remote') return typeof image.url === 'string';
        if (image.source === 'feishu') {
          return typeof image.docToken === 'string' && typeof image.blockId === 'number';
        }
        return (
          typeof image.name === 'string' &&
          typeof image.mime === 'string' &&
          typeof image.size === 'number' &&
          typeof image.data === 'string' &&
          typeof image.sha256 === 'string'
        );
      })
    : [];
  return {
    schemaVersion: 1,
    version: typeof value.version === 'number' ? value.version : 0,
    source: typeof value.source === 'string' ? value.source : DEFAULT_SOURCE,
    fonts,
    embeddedFonts,
    images,
  };
};

export const makeAssetId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export const extensionForMime = (mime: string): string => {
  const normalized = mime.split(';')[0].trim().toLowerCase();
  return (
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
    }[normalized] ?? 'png'
  );
};

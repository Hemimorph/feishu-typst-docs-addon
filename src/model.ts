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
  font: ("Noto Serif CJK SC", "Libertinus Serif"),
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

export interface AvailableTypstFont {
  family: string;
  builtIn: boolean;
  customUrls: string[];
  variants: string[];
}

interface RawFontFace {
  family?: unknown;
  variant?: {
    style?: unknown;
    weight?: unknown;
    stretch?: unknown;
  };
}

interface RawFontInfo {
  info?: RawFontFace[];
}

const builtInFont = (family: string, variants: string[]): AvailableTypstFont => ({
  family,
  builtIn: true,
  customUrls: [],
  variants,
});

// These are the families bundled by typst.ts's `text` and `cjk` asset sets.
// Keep the family names exact: Typst silently falls back when a name is wrong.
export const BUILTIN_TYPST_FONTS: AvailableTypstFont[] = [
  builtInFont('DejaVu Sans Mono', ['Regular', 'Bold', 'Oblique', 'Bold Oblique']),
  builtInFont('Inria Serif', ['Regular', 'Bold', 'Italic', 'Bold Italic']),
  builtInFont('Libertinus Serif', [
    'Regular',
    'Semibold',
    'Bold',
    'Italic',
    'Semibold Italic',
    'Bold Italic',
  ]),
  builtInFont('New Computer Modern', ['Regular', 'Bold', 'Italic', 'Bold Italic']),
  builtInFont('New Computer Modern Math', ['Regular', 'Book', 'Bold']),
  builtInFont('Noto Serif CJK SC', ['Regular']),
  builtInFont('Roboto', ['Regular']),
];

const normalizedFamily = (family: string) => family.trim().toLocaleLowerCase();

const weightName = (weight: unknown): string => {
  if (typeof weight !== 'number') return '';
  return (
    {
      100: 'Thin',
      200: 'Extra Light',
      300: 'Light',
      400: 'Regular',
      500: 'Medium',
      600: 'Semibold',
      700: 'Bold',
      800: 'Extra Bold',
      900: 'Black',
    }[weight] ?? String(weight)
  );
};

const variantName = (face: RawFontFace): string => {
  const weight = weightName(face.variant?.weight);
  const style = typeof face.variant?.style === 'string' ? face.variant.style : '';
  const styleLabel = style && style !== 'normal'
    ? `${style.charAt(0).toLocaleUpperCase()}${style.slice(1)}`
    : '';
  return [weight, styleLabel].filter(Boolean).join(' ') || 'Regular';
};

export const fontInfoToCatalog = (value: unknown, url: string): AvailableTypstFont[] => {
  const faces = (value as RawFontInfo | undefined)?.info;
  if (!Array.isArray(faces)) return [];

  const byFamily = new Map<string, AvailableTypstFont>();
  for (const face of faces) {
    if (typeof face?.family !== 'string' || !face.family.trim()) continue;
    const family = face.family.trim();
    const key = normalizedFamily(family);
    const current = byFamily.get(key) ?? {
      family,
      builtIn: false,
      customUrls: [url],
      variants: [],
    };
    const variant = variantName(face);
    if (!current.variants.includes(variant)) current.variants.push(variant);
    byFamily.set(key, current);
  }

  return Array.from(byFamily.values());
};

export const mergeFontCatalog = (
  ...catalogs: AvailableTypstFont[][]
): AvailableTypstFont[] => {
  const merged = new Map<string, AvailableTypstFont>();
  for (const catalog of catalogs) {
    for (const font of catalog) {
      const key = normalizedFamily(font.family);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, {
          ...font,
          customUrls: [...font.customUrls],
          variants: [...font.variants],
        });
        continue;
      }
      current.builtIn ||= font.builtIn;
      for (const url of font.customUrls) {
        if (!current.customUrls.includes(url)) current.customUrls.push(url);
      }
      for (const variant of font.variants) {
        if (!current.variants.includes(variant)) current.variants.push(variant);
      }
    }
  }
  return Array.from(merged.values()).sort((left, right) =>
    left.family.localeCompare(right.family, undefined, { sensitivity: 'base' }),
  );
};

const stripTypstComments = (source: string): string => {
  let result = '';
  let index = 0;
  let blockDepth = 0;
  let inString = false;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (blockDepth > 0) {
      if (char === '/' && next === '*') {
        blockDepth += 1;
        index += 2;
      } else if (char === '*' && next === '/') {
        blockDepth -= 1;
        index += 2;
      } else {
        result += char === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (!inString && char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (!inString && char === '/' && next === '*') {
      blockDepth = 1;
      index += 2;
      continue;
    }

    result += char;
    if (char === '"' && source[index - 1] !== '\\') inString = !inString;
    index += 1;
  }

  return result;
};

const readString = (source: string, start: number): { value: string; end: number } | undefined => {
  if (source[start] !== '"') return undefined;
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\' && index + 1 < source.length) {
      value += source[index + 1];
      index += 1;
    } else if (char === '"') {
      return { value, end: index + 1 };
    } else {
      value += char;
    }
  }
  return undefined;
};

export const extractLiteralFontFamilies = (source: string): string[] => {
  const content = stripTypstComments(source);
  const families: string[] = [];
  const seen = new Set<string>();
  const setting = /\bfont\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = setting.exec(content))) {
    let index = setting.lastIndex;
    while (/\s/.test(content[index] ?? '')) index += 1;
    const tuple = content[index] === '(';
    if (tuple) index += 1;

    while (index < content.length) {
      while (/\s|,/.test(content[index] ?? '')) index += 1;
      const literal = readString(content, index);
      if (!literal) break;
      const family = literal.value.trim();
      const key = normalizedFamily(family);
      if (family && !seen.has(key)) {
        seen.add(key);
        families.push(family);
      }
      index = literal.end;
      while (/\s/.test(content[index] ?? '')) index += 1;
      if (!tuple || content[index] === ')') break;
      if (content[index] !== ',') break;
    }
  }

  return families;
};

export const findUnavailableLiteralFonts = (
  source: string,
  available: AvailableTypstFont[],
): string[] => {
  const availableFamilies = new Set(available.map((font) => normalizedFamily(font.family)));
  return extractLiteralFontFamilies(source).filter(
    (family) => !availableFamilies.has(normalizedFamily(family)),
  );
};

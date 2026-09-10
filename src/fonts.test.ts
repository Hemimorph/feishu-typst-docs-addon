import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TYPST_FONTS,
  extractLiteralFontFamilies,
  findUnavailableLiteralFonts,
  fontInfoToCatalog,
  mergeFontCatalog,
} from './fonts';

describe('fontInfoToCatalog', () => {
  it('extracts all families and faces from a font collection', () => {
    const result = fontInfoToCatalog(
      {
        info: [
          { family: 'Example Sans', variant: { style: 'normal', weight: 400 } },
          { family: 'Example Sans', variant: { style: 'italic', weight: 700 } },
          { family: 'Example Serif', variant: { style: 'normal', weight: 400 } },
        ],
      },
      'https://cdn.example/font.ttc',
    );

    expect(result).toEqual([
      {
        family: 'Example Sans',
        builtIn: false,
        customUrls: ['https://cdn.example/font.ttc'],
        variants: ['Regular', 'Bold Italic'],
      },
      {
        family: 'Example Serif',
        builtIn: false,
        customUrls: ['https://cdn.example/font.ttc'],
        variants: ['Regular'],
      },
    ]);
  });
});

describe('font catalog', () => {
  it('contains the actual built-in Typst family names', () => {
    expect(BUILTIN_TYPST_FONTS.map((font) => font.family)).toContain('Noto Serif SC');
    expect(BUILTIN_TYPST_FONTS.map((font) => font.family)).toContain('Libertinus Serif');
  });

  it('merges built-in and custom faces for the same family', () => {
    const merged = mergeFontCatalog(BUILTIN_TYPST_FONTS, [
      {
        family: 'Libertinus Serif',
        builtIn: false,
        customUrls: ['https://cdn.example/libertinus-black.otf'],
        variants: ['Black'],
      },
    ]);
    const libertinus = merged.find((font) => font.family === 'Libertinus Serif');
    expect(libertinus).toMatchObject({ builtIn: true });
    expect(libertinus?.variants).toContain('Black');
  });
});

describe('extractLiteralFontFamilies', () => {
  it('extracts direct and fallback font literals', () => {
    expect(
      extractLiteralFontFamilies(`
        #set text(font: ("Noto Serif CJK SC", "Libertinus Serif"))
        #text(font: "Example Sans")[Hello]
      `),
    ).toEqual(['Noto Serif CJK SC', 'Libertinus Serif', 'Example Sans']);
  });

  it('ignores commented font settings', () => {
    expect(
      extractLiteralFontFamilies(`
        // #set text(font: "Missing One")
        /* #set text(font: "Missing Two") */
        #set text(font: "Roboto")
      `),
    ).toEqual(['Roboto']);
  });

  it('reports names that would silently fall back', () => {
    expect(
      findUnavailableLiteralFonts(
        '#set text(font: ("Noto Serif SC", "Times New Roman"))',
        BUILTIN_TYPST_FONTS,
      ),
    ).toEqual(['Times New Roman']);
  });
});

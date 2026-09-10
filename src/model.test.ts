import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE,
  getTypstRuntimeAssetUrls,
  isImageAssetReferenced,
  normalizeAssetPath,
  normalizeImageAssets,
  normalizeRecord,
  normalizeResourceMirror,
  typstRenderKey,
} from './model';

describe('normalizeResourceMirror', () => {
  it('keeps path prefixes and removes trailing slashes', () => {
    expect(normalizeResourceMirror(' https://mirror.example.com/npm-cdn/// ')).toBe(
      'https://mirror.example.com/npm-cdn',
    );
  });

  it.each([
    '',
    'not a URL',
    'http://mirror.example.com',
    'https://user:pass@mirror.example.com',
    'https://mirror.example.com?token=secret',
    'https://mirror.example.com/#fragment',
  ])('rejects unsafe mirror base %s', (mirror) => {
    expect(() => normalizeResourceMirror(mirror)).toThrow();
  });
});

describe('getTypstRuntimeAssetUrls', () => {
  it('resolves every built-in asset through npm routes on the selected mirror', () => {
    const urls = getTypstRuntimeAssetUrls('https://mirror.example.com/npm/');

    expect(urls.compilerWasm).toEqual({
      url: 'https://mirror.example.com/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm',
    });
    expect(urls.rendererWasm).toEqual({
      url: 'https://mirror.example.com/npm/@myriaddreamin/typst-ts-renderer@0.7.0/pkg/typst_ts_renderer_bg.wasm',
    });
    expect(urls.fonts).toContainEqual({
      url: 'https://mirror.example.com/npm/@typst-wasm/fonts@1.0.0/dist/files/LibertinusSerif-Regular.otf',
    });
    expect(urls.fonts).toContainEqual({
      url: 'https://mirror.example.com/npm/@betteroffice/fonts-cjk@0.1.0/assets/NotoSerifSC-Regular.otf',
    });
    expect(urls.fonts.every((asset) => asset.url.startsWith('https://mirror.example.com/npm/'))).toBe(true);
  });

  it('resolves package tarballs and entries for a standard NPM Registry', () => {
    const urls = getTypstRuntimeAssetUrls(
      'https://artifacts.example.com/repository/typst/',
      'npm-registry',
    );

    expect(urls.rendererWasm).toEqual({
      url: 'https://artifacts.example.com/repository/typst/@myriaddreamin/typst-ts-renderer/-/typst-ts-renderer-0.7.0.tgz',
      archivePath: 'package/pkg/typst_ts_renderer_bg.wasm',
    });
    expect(urls.fonts).toContainEqual({
      url: 'https://artifacts.example.com/repository/typst/@betteroffice/fonts-cjk/-/fonts-cjk-0.1.0.tgz',
      archivePath: 'package/assets/NotoSerifSC-Regular.otf',
    });
  });
});

describe('normalizeAssetPath', () => {
  it('normalizes paths relative to the assets directory', () => {
    expect(normalizeAssetPath('assets/figures/chart.svg')).toBe('figures/chart.svg');
  });

  it.each(['/logo.png', '../logo.png', 'a/../logo.png', 'a\\logo.png', '']) (
    'rejects unsafe path %s',
    (path) => expect(() => normalizeAssetPath(path)).toThrow(),
  );
});

describe('normalizeRecord', () => {
  it('uses a usable default for missing records', () => {
    const result = normalizeRecord(undefined);
    expect(result.source).toBe(DEFAULT_SOURCE);
    expect(result.images).toEqual([]);
    expect(result.embeddedFonts).toEqual([]);
  });

  it('drops malformed resources', () => {
    const result = normalizeRecord({
      schemaVersion: 1,
      version: 2,
      source: 'Hello',
      fonts: ['font.otf', 1],
      images: [
        { id: 'ok', source: 'remote', path: 'a.png', url: 'https://example.com/a.png' },
        { id: 'bad', source: 'feishu', path: 'b.png' },
      ],
    });

    expect(result.fonts).toEqual(['font.otf']);
    expect(result.images).toHaveLength(1);
  });

  it('keeps valid embedded fonts and images', () => {
    const result = normalizeRecord({
      schemaVersion: 1,
      version: 1,
      source: 'Embedded',
      fonts: [],
      embeddedFonts: [
        {
          id: 'font',
          name: 'font.woff',
          mime: 'font/woff',
          size: 3,
          data: 'AQID',
          sha256: 'font-hash',
        },
      ],
      images: [
        {
          id: 'image',
          source: 'embedded',
          path: 'image.png',
          name: 'image.png',
          mime: 'image/png',
          size: 3,
          data: 'AQID',
          sha256: 'image-hash',
        },
      ],
    });

    expect(result.embeddedFonts[0].name).toBe('font.woff');
    expect(result.images[0]).toMatchObject({ source: 'embedded', path: 'image.png' });
  });
});

describe('typstRenderKey', () => {
  it('tracks embedded content by digest without copying base64 into the key', () => {
    const data = 'A'.repeat(1000);
    const key = typstRenderKey({
      ...normalizeRecord(undefined),
      embeddedFonts: [
        {
          id: 'font',
          name: 'font.otf',
          mime: 'font/otf',
          size: 750,
          data,
          sha256: 'font-digest',
        },
      ],
    });
    expect(key).toContain('font-digest');
    expect(key).not.toContain(data);
  });
});

describe('normalizeImageAssets', () => {
  it('normalizes paths and rejects duplicates', () => {
    expect(() =>
      normalizeImageAssets([
        { id: 'a', source: 'remote', path: 'logo.png', url: 'https://example.com/a.png' },
        { id: 'b', source: 'remote', path: 'assets/logo.png', url: 'https://example.com/b.png' },
      ]),
    ).toThrow('图片资源路径重复');
  });
});

describe('isImageAssetReferenced', () => {
  it('matches the virtual assets path inserted into Typst source', () => {
    expect(isImageAssetReferenced('#image("assets/figures/logo.png")', 'figures/logo.png')).toBe(true);
    expect(isImageAssetReferenced('No image here', 'figures/logo.png')).toBe(false);
  });
});

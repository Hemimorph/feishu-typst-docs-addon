import { describe, expect, it } from 'vitest';
import { getTypstRuntimeAssetUrls } from './model';
import { extractTarEntry, loadRuntimeAssetBytes, runtimeAssetKey } from './npm-archive';

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

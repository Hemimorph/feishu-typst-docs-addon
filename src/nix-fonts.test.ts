import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decompressNixNar,
  extractNixNarFonts,
  loadNixOutPathFonts,
  nixNarInfoUrl,
  parseNixNarInfo,
  parseNixOutPath,
} from './nix-fonts';
import {
  subscribeRuntimeDownloadProgress,
  type RuntimeDownloadProgress,
} from './npm-archive';

const encode = (value: string) => new TextEncoder().encode(value);

const concat = (parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const narString = (value: string | Uint8Array): Uint8Array => {
  const bytes = typeof value === 'string' ? encode(value) : value;
  const paddedLength = Math.ceil(bytes.byteLength / 8) * 8;
  const result = new Uint8Array(8 + paddedLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, bytes.byteLength, true);
  view.setUint32(4, 0, true);
  result.set(bytes, 8);
  return result;
};

const regular = (contents: Uint8Array): Uint8Array =>
  concat([
    narString('('),
    narString('type'),
    narString('regular'),
    narString('contents'),
    narString(contents),
    narString(')'),
  ]);

const symlink = (target: string): Uint8Array =>
  concat([
    narString('('),
    narString('type'),
    narString('symlink'),
    narString('target'),
    narString(target),
    narString(')'),
  ]);

const directory = (entries: Record<string, Uint8Array>): Uint8Array =>
  concat([
    narString('('),
    narString('type'),
    narString('directory'),
    ...Object.entries(entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, node]) => [
        narString('entry'),
        narString('('),
        narString('name'),
        narString(name),
        narString('node'),
        node,
        narString(')'),
      ]),
    narString(')'),
  ]);

const narArchive = (root: Uint8Array): Uint8Array => concat([narString('nix-archive-1'), root]);

const font = (signature: string, name: string): Uint8Array =>
  concat([encode(signature), encode(name)]);

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const HASH = '0123456789abcdfghijklmnpqrsvwxyz';
const OUT_PATH = `/nix/store/${HASH}-demo-fonts-1.0`;
const SOURCE_HASH = '11111111111111111111111111111111';
const SOURCE_PATH = `/nix/store/${SOURCE_HASH}-shanggu-fonts-1.028-serif`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Nix outPath parsing', () => {
  it('derives the official cache narinfo URL from a validated store path', () => {
    expect(parseNixOutPath(` ${OUT_PATH} `)).toEqual({
      storePath: OUT_PATH,
      hashPart: HASH,
      name: 'demo-fonts-1.0',
    });
    expect(nixNarInfoUrl(OUT_PATH)).toBe(`https://cache.nixos.org/${HASH}.narinfo`);
  });

  it.each([
    'nixpkgs#font',
    '/nix/store/short-font',
    `/nix/store/${HASH}/font`,
    `/nix/store/${HASH}-font/child`,
  ])('rejects an unsafe or incomplete outPath: %s', (value) => {
    expect(() => parseNixOutPath(value)).toThrow('Nix outPath');
  });
});

describe('narinfo parsing', () => {
  const valid = [
    `StorePath: ${OUT_PATH}`,
    'URL: nar/example.nar.zst?sha256=example',
    'Compression: zstd',
    'FileHash: sha256:0000000000000000000000000000000000000000000000000000',
    'FileSize: 42',
    'NarHash: sha256:0000000000000000000000000000000000000000000000000000',
    'NarSize: 100',
  ].join('\n');

  it('accepts the requested store path and resolves a cache-relative NAR URL', () => {
    expect(parseNixNarInfo(valid, OUT_PATH)).toMatchObject({
      storePath: OUT_PATH,
      url: 'https://cache.nixos.org/nar/example.nar.zst?sha256=example',
      compression: 'zstd',
      fileSize: 42,
      narSize: 100,
    });
  });

  it('rejects redirects to an unrelated download origin', () => {
    expect(() =>
      parseNixNarInfo(valid.replace('nar/example.nar.zst', 'https://evil.example/a.nar'), OUT_PATH),
    ).toThrow('不属于 cache.nixos.org');
  });

  it('rejects a narinfo for a different store path', () => {
    expect(() => parseNixNarInfo(valid.replace('demo-fonts', 'other-fonts'), OUT_PATH)).toThrow(
      'StorePath',
    );
  });
});

describe('NAR font extraction', () => {
  it('recursively extracts supported font files and ignores unrelated files', () => {
    const regularFont = font('OTTO', 'regular');
    const collection = font('ttcf', 'collection');
    const nar = narArchive(
      directory({
        share: directory({
          fonts: directory({
            'Demo-Regular.otf': regular(regularFont),
            'Demo.ttc': regular(collection),
            'README.txt': regular(encode('metadata')),
          }),
        }),
      }),
    );

    expect(extractNixNarFonts(nar, 'demo-fonts-1.0')).toEqual([
      { path: 'demo-fonts-1.0/share/fonts/Demo-Regular.otf', bytes: regularFont },
      { path: 'demo-fonts-1.0/share/fonts/Demo.ttc', bytes: collection },
    ]);
  });

  it('reports a NAR containing only unsupported WOFF2 fonts', () => {
    const nar = narArchive(directory({ 'Only.woff2': regular(font('wOF2', 'unsupported')) }));
    expect(() => extractNixNarFonts(nar)).toThrow('只有 WOFF2');
  });

  it('rejects invalid NAR framing', () => {
    expect(() => extractNixNarFonts(encode('not a NAR'))).toThrow('NAR');
  });
});

describe('Nix cache loading', () => {
  it('loads, verifies and extracts an uncompressed NAR from cache.nixos.org', async () => {
    const fontBytes = font('OTTO', 'loaded');
    const nar = narArchive(directory({ 'Loaded.otf': regular(fontBytes) }));
    expect(nar.byteLength).toBe(304);
    const fileHash = 'sha256:1n2pk387cl2vpdd4pwzj2n7lfrv070lh5aqrp45zx7pg0whfpy31';
    const narInfo = [
      `StorePath: ${OUT_PATH}`,
      'URL: nar/test.nar',
      'Compression: none',
      `FileHash: ${fileHash}`,
      `FileSize: ${nar.byteLength}`,
      `NarHash: ${fileHash}`,
      `NarSize: ${nar.byteLength}`,
    ].join('\n');
    const responses = new Map<string, Uint8Array>([
      [nixNarInfoUrl(OUT_PATH), encode(narInfo)],
      ['https://cache.nixos.org/nar/test.nar', nar],
    ]);
    const fetchMock = vi.fn(async (request: Request) => {
      const bytes = responses.get(request.url);
      return bytes
        ? new Response(bytes.slice().buffer, { status: 200 })
        : new Response(undefined, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadNixOutPathFonts(OUT_PATH)).resolves.toEqual([
      { path: 'demo-fonts-1.0/Loaded.otf', bytes: fontBytes },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows font symlinks into another store path', async () => {
    const progress: RuntimeDownloadProgress[] = [];
    const unsubscribe = subscribeRuntimeDownloadProgress((value) => progress.push(value));
    const fontBytes = font('ttcf', 'shanggu');
    const outputNar = narArchive(
      directory({
        share: directory({
          fonts: directory({
            'ShangguSerif.ttc': symlink(
              `${SOURCE_PATH}/share/fonts/truetype/ShangguSerif.ttc`,
            ),
          }),
        }),
      }),
    );
    const sourceNar = narArchive(
      directory({
        share: directory({
          fonts: directory({
            truetype: directory({
              'ShangguSerif.ttc': regular(fontBytes),
            }),
          }),
        }),
      }),
    );
    const responses = new Map<string, Uint8Array>();

    const addStore = async (storePath: string, nar: Uint8Array, narName: string) => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', nar.slice().buffer));
      const fileHash = `sha256-${toBase64(digest)}`;
      const narInfo = [
        `StorePath: ${storePath}`,
        `URL: nar/${narName}`,
        'Compression: none',
        `FileHash: ${fileHash}`,
        `FileSize: ${nar.byteLength}`,
        `NarHash: ${fileHash}`,
        `NarSize: ${nar.byteLength}`,
      ].join('\n');
      responses.set(nixNarInfoUrl(storePath), encode(narInfo));
      responses.set(`https://cache.nixos.org/nar/${narName}`, nar);
    };
    await addStore(OUT_PATH, outputNar, 'linked-output.nar');
    await addStore(SOURCE_PATH, sourceNar, 'font-source.nar');

    const fetchMock = vi.fn(async (request: Request) => {
      const bytes = responses.get(request.url);
      return bytes
        ? new Response(bytes.slice().buffer, { status: 200 })
        : new Response(undefined, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadNixOutPathFonts(OUT_PATH)).resolves.toEqual([
      {
        path: 'demo-fonts-1.0/share/fonts/ShangguSerif.ttc',
        bytes: fontBytes,
      },
    ]);
    unsubscribe();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(progress.some((value) => value.active && value.loadedBytes > 0)).toBe(true);
    expect(progress[progress.length - 1].active).toBe(false);
  });

  it('rejects a downloaded NAR whose FileHash does not match', async () => {
    const nar = narArchive(directory({ 'Loaded.otf': regular(font('OTTO', 'loaded')) }));
    const narInfo = [
      `StorePath: ${OUT_PATH}`,
      'URL: nar/test.nar',
      'Compression: none',
      `FileHash: sha256-${toBase64(new Uint8Array(32))}`,
      `FileSize: ${nar.byteLength}`,
      `NarHash: sha256-${toBase64(new Uint8Array(32))}`,
      `NarSize: ${nar.byteLength}`,
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) =>
        request.url.endsWith('.narinfo')
          ? new Response(encode(narInfo).slice().buffer)
          : new Response(nar.slice().buffer),
      ),
    );

    await expect(loadNixOutPathFonts(OUT_PATH)).rejects.toThrow('FileHash 校验失败');
  });

  it('decompresses Zstandard data used by the official cache', async () => {
    const packed = Uint8Array.from(
      atob('KLUv/QRYaQAAbml4LWFyY2hpdmUtMfB8/K4='),
      (character) => character.charCodeAt(0),
    );
    await expect(decompressNixNar(packed, 'zstd')).resolves.toEqual(encode('nix-archive-1'));
  });
});

import { describe, expect, it } from 'vitest';
import { extractFontFiles, fontArchiveCrc32 } from './font-archive';

const encode = (value: string) => new TextEncoder().encode(value);
const otf = (label: string) => {
  const bytes = new Uint8Array(4 + label.length);
  bytes.set(encode('OTTO'));
  bytes.set(encode(label), 4);
  return bytes;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const compress = async (bytes: Uint8Array, format: 'gzip' | 'deflate-raw') => {
  const stream = new Blob([bytes.slice().buffer])
    .stream()
    .pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const makeZip = async (
  entries: Array<{ path: string; bytes: Uint8Array; deflate?: boolean }>,
  corruptCrc = false,
): Promise<Uint8Array> => {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encode(entry.path);
    const packed = entry.deflate ? await compress(entry.bytes, 'deflate-raw') : entry.bytes;
    const method = entry.deflate ? 8 : 0;
    const crc = fontArchiveCrc32(entry.bytes) ^ (corruptCrc ? 1 : 0);
    const local = new Uint8Array(30 + name.byteLength + packed.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, packed.byteLength, true);
    localView.setUint32(22, entry.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(packed, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, packed.byteLength, true);
    centralView.setUint32(24, entry.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }

  const central = concat(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, localOffset, true);
  return concat([...localParts, central, end]);
};

const writeTarText = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
) => target.set(encode(value).subarray(0, length), offset);

const makeTar = (entries: Array<{ path: string; bytes: Uint8Array }>): Uint8Array => {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const padded = Math.ceil(entry.bytes.byteLength / 512) * 512;
    const part = new Uint8Array(512 + padded);
    writeTarText(part, 0, 100, entry.path);
    writeTarText(
      part,
      124,
      12,
      `${entry.bytes.byteLength.toString(8).padStart(11, '0')}\0`,
    );
    part[156] = 48;
    writeTarText(part, 257, 6, 'ustar\0');
    part.fill(32, 148, 156);
    const checksum = part.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    writeTarText(part, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    part.set(entry.bytes, 512);
    parts.push(part);
  }
  return concat([...parts, new Uint8Array(1024)]);
};

describe('extractFontFiles', () => {
  it('keeps a direct font URL compatible', async () => {
    const bytes = otf('direct');
    await expect(extractFontFiles(bytes, 'https://cdn.example/font.otf')).resolves.toEqual([
      { path: 'font.otf', bytes },
    ]);
  });

  it('scans every supported font in a ZIP and ignores unrelated files', async () => {
    const regular = otf('regular');
    const bold = otf('bold');
    const zip = await makeZip([
      { path: 'family/Regular.otf', bytes: regular },
      { path: 'README.txt', bytes: encode('not a font') },
      { path: 'family/Bold.ttf', bytes: bold },
    ]);

    await expect(extractFontFiles(zip, 'https://cdn.example/family.zip')).resolves.toEqual([
      { path: 'family/Regular.otf', bytes: regular },
      { path: 'family/Bold.ttf', bytes: bold },
    ]);
  });

  it('supports deflated ZIP font entries', async () => {
    const bytes = otf('deflated font bytes repeated repeated repeated');
    const zip = await makeZip([{ path: 'fonts/Compressed.otf', bytes, deflate: true }]);

    await expect(extractFontFiles(zip, 'https://cdn.example/fonts.zip')).resolves.toEqual([
      { path: 'fonts/Compressed.otf', bytes },
    ]);
  });

  it('scans all fonts in a tar.gz/tgz resource', async () => {
    const first = otf('first');
    const second = otf('second');
    const tgz = await compress(
      makeTar([
        { path: 'package/fonts/First.otf', bytes: first },
        { path: 'package/fonts/Second.ttf', bytes: second },
      ]),
      'gzip',
    );

    await expect(extractFontFiles(tgz, 'https://cdn.example/fonts.tgz')).resolves.toEqual([
      { path: 'package/fonts/First.otf', bytes: first },
      { path: 'package/fonts/Second.ttf', bytes: second },
    ]);
  });

  it('rejects a ZIP entry with a bad CRC', async () => {
    const zip = await makeZip([{ path: 'Bad.otf', bytes: otf('bad') }], true);
    await expect(extractFontFiles(zip, 'https://cdn.example/bad.zip')).rejects.toThrow(
      'CRC 校验失败',
    );
  });

  it('reports an archive containing only unsupported WOFF2 fonts', async () => {
    const zip = await makeZip([{ path: 'Only.woff2', bytes: encode('wOF2fake') }]);
    await expect(extractFontFiles(zip, 'https://cdn.example/woff2.zip')).rejects.toThrow(
      '只有 WOFF2',
    );
  });

  it('rejects an unrelated CDN response', async () => {
    await expect(
      extractFontFiles(encode('<html>not found</html>'), 'https://cdn.example/fonts.zip'),
    ).rejects.toThrow('不是受支持的字体');
  });
});

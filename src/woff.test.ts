import { describe, expect, it } from 'vitest';
import { convertWoffToSfnt, detectFontContainer, normalizeFontBytes } from './woff';

const align4 = (value: number) => (value + 3) & ~3;

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const makeWoff = async (tableData: Uint8Array) => {
  const compressed = new Uint8Array(
    await new Response(
      new Blob([ownedBuffer(tableData)]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  const payload = compressed.byteLength < tableData.byteLength ? compressed : tableData;
  const file = new Uint8Array(align4(64 + payload.byteLength));
  const view = new DataView(file.buffer);
  view.setUint32(0, 0x774f4646);
  view.setUint32(4, 0x00010000);
  view.setUint32(8, file.byteLength);
  view.setUint16(12, 1);
  view.setUint32(16, 28 + align4(tableData.byteLength));
  view.setUint32(44, 0x6e616d65);
  view.setUint32(48, 64);
  view.setUint32(52, payload.byteLength);
  view.setUint32(56, tableData.byteLength);
  view.setUint32(60, 0x12345678);
  file.set(payload, 64);
  return file;
};

describe('WOFF font normalization', () => {
  it('converts a compressed WOFF table back into an sfnt table', async () => {
    const table = new TextEncoder().encode('A'.repeat(512));
    const result = await convertWoffToSfnt(await makeWoff(table));
    const view = new DataView(result.buffer);

    expect(view.getUint32(0)).toBe(0x00010000);
    expect(view.getUint16(4)).toBe(1);
    expect(view.getUint32(12)).toBe(0x6e616d65);
    expect(view.getUint32(16)).toBe(0x12345678);
    expect(result.slice(view.getUint32(20), view.getUint32(20) + table.length)).toEqual(table);
  });

  it('keeps raw sfnt bytes unchanged', async () => {
    const bytes = new Uint8Array([0, 1, 0, 0]);
    expect(detectFontContainer(bytes)).toBe('sfnt');
    expect(await normalizeFontBytes(bytes)).toBe(bytes);
  });

  it('gives a precise error for WOFF2', async () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);
    await expect(normalizeFontBytes(bytes)).rejects.toThrow('暂不支持 WOFF2');
  });
});

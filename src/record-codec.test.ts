import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from './embedded';
import { DEFAULT_RECORD, type TypstAddonRecord } from './model';
import {
  compressedRecordBytes,
  ensureCompressedRecordQuota,
  isCompressedAddonRecord,
  packAddonRecord,
  unpackAddonRecord,
} from './record-codec';

const deterministicBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
};

const makeRecord = (): TypstAddonRecord => ({
  ...DEFAULT_RECORD,
  version: 7,
  source: '= 重复内容\n'.repeat(2000),
  embeddedFonts: [
    {
      id: 'font',
      name: 'font.otf',
      mime: 'font/otf',
      size: 6,
      data: bytesToBase64(new Uint8Array([1, 2, 3, 1, 2, 3])),
      sha256: 'font-sha',
    },
  ],
});

describe('compressed Record codec', () => {
  it('round trips the complete logical Record through gzip', async () => {
    const logical = makeRecord();
    const packed = await packAddonRecord(logical);

    expect(isCompressedAddonRecord(packed)).toBe(true);
    expect(packed.encoding).toBe('gzip-base64');
    expect(await unpackAddonRecord(packed)).toEqual(logical);
  });

  it('reads existing uncompressed schema version 1 records', async () => {
    const logical = makeRecord();
    expect(await unpackAddonRecord(logical)).toEqual(logical);
  });

  it('reports the actual compressed storage size', async () => {
    const logical = makeRecord();
    const uncompressedBytes = new TextEncoder().encode(JSON.stringify(logical)).byteLength;

    expect(await compressedRecordBytes(logical)).toBeLessThan(uncompressedBytes / 4);
  });

  it('allows highly compressible logical content larger than 500 KB', async () => {
    const logical = { ...DEFAULT_RECORD, source: 'Typst content\n'.repeat(50_000) };

    await expect(ensureCompressedRecordQuota(logical)).resolves.toMatchObject({
      encoding: 'gzip-base64',
    });
  });

  it('still enforces 500 KB after losslessly packing incompressible assets', async () => {
    const bytes = deterministicBytes(400_000);
    const logical: TypstAddonRecord = {
      ...DEFAULT_RECORD,
      embeddedFonts: [],
      images: [
        {
          id: 'random-image',
          source: 'embedded',
          path: 'random.bin',
          name: 'random.bin',
          mime: 'application/octet-stream',
          size: bytes.length,
          data: bytesToBase64(bytes),
          sha256: 'random-sha',
        },
      ],
    };

    await expect(ensureCompressedRecordQuota(logical)).rejects.toThrow('500 KB');
  });

  it('keeps a representative 300 KB incompressible asset within the packed quota', async () => {
    const bytes = deterministicBytes(300_000);
    const logical: TypstAddonRecord = {
      ...DEFAULT_RECORD,
      images: [
        {
          id: 'image',
          source: 'embedded',
          path: 'image.jpg',
          name: 'image.jpg',
          mime: 'image/jpeg',
          size: bytes.length,
          data: bytesToBase64(bytes),
          sha256: 'image-sha',
        },
      ],
    };

    await expect(ensureCompressedRecordQuota(logical)).resolves.toMatchObject({
      encoding: 'gzip-base64',
    });
  });

  it('rejects corrupt compressed data instead of silently resetting the document', async () => {
    await expect(
      unpackAddonRecord({
        schemaVersion: 2,
        version: 1,
        encoding: 'gzip-base64',
        payload: bytesToBase64(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow('组件压缩数据无法读取');
  });
});

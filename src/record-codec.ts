import type { RecordData } from '@lark-opdev/block-docs-addon-api';
import { base64ToBytes, bytesToBase64, ensureRecordQuota, serializedRecordBytes } from './embedded';
import { normalizeRecord, type TypstAddonRecord } from './model';

export const COMPRESSED_RECORD_SCHEMA_VERSION = 2;
export const MAX_UNCOMPRESSED_RECORD_BYTES = 20 * 1024 * 1024;

interface CompressedRecordPayload {
  formatVersion: 1;
  source: string;
  fonts: string[];
  embeddedFonts: TypstAddonRecord['embeddedFonts'];
  images: TypstAddonRecord['images'];
}

export interface CompressedAddonRecord extends RecordData {
  schemaVersion: typeof COMPRESSED_RECORD_SCHEMA_VERSION;
  version: number;
  encoding: 'gzip-base64';
  payload: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const streamBytes = async (
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> => {
  const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const gzipBytes = (bytes: Uint8Array): Promise<Uint8Array> =>
  typeof CompressionStream === 'undefined'
    ? Promise.reject(new Error('当前飞书客户端不支持 gzip CompressionStream'))
    : streamBytes(bytes, new CompressionStream('gzip'));

export const gunzipBytes = (bytes: Uint8Array): Promise<Uint8Array> =>
  typeof DecompressionStream === 'undefined'
    ? Promise.reject(new Error('当前飞书客户端不支持 gzip DecompressionStream'))
    : streamBytes(bytes, new DecompressionStream('gzip'));

const toPayload = (record: TypstAddonRecord): CompressedRecordPayload => ({
  formatVersion: 1,
  source: record.source,
  fonts: record.fonts,
  embeddedFonts: record.embeddedFonts,
  images: record.images,
});

export const packAddonRecord = async (
  record: TypstAddonRecord,
): Promise<CompressedAddonRecord> => {
  const plain = new TextEncoder().encode(JSON.stringify(toPayload(record)));
  if (plain.byteLength > MAX_UNCOMPRESSED_RECORD_BYTES) {
    throw new Error('组件解压后的数据超过 20 MiB 安全上限，请减少嵌入资源');
  }
  const compressed = await gzipBytes(plain);
  return {
    schemaVersion: COMPRESSED_RECORD_SCHEMA_VERSION,
    version: record.version,
    encoding: 'gzip-base64',
    payload: bytesToBase64(compressed),
  };
};

export const compressedRecordBytes = async (record: TypstAddonRecord): Promise<number> =>
  serializedRecordBytes(await packAddonRecord(record));

export const ensureCompressedRecordQuota = async (
  record: TypstAddonRecord,
): Promise<CompressedAddonRecord> => {
  const packed = await packAddonRecord(record);
  ensureRecordQuota(packed);
  return packed;
};

export const isCompressedAddonRecord = (value: unknown): value is CompressedAddonRecord =>
  isObject(value) &&
  value.schemaVersion === COMPRESSED_RECORD_SCHEMA_VERSION &&
  typeof value.version === 'number' &&
  value.encoding === 'gzip-base64' &&
  typeof value.payload === 'string';

export const unpackAddonRecord = async (value: unknown): Promise<TypstAddonRecord> => {
  if (!isCompressedAddonRecord(value)) return normalizeRecord(value);

  try {
    const compressed = base64ToBytes(value.payload);
    const plain = await gunzipBytes(compressed);
    if (plain.byteLength > MAX_UNCOMPRESSED_RECORD_BYTES) {
      throw new Error('解压后的组件数据超过安全上限');
    }
    const payload: unknown = JSON.parse(new TextDecoder().decode(plain));
    if (!isObject(payload) || payload.formatVersion !== 1) {
      throw new Error('不支持的压缩数据版本');
    }
    return normalizeRecord({
      ...payload,
      schemaVersion: 1,
      version: value.version,
    });
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    throw new Error(`组件压缩数据无法读取：${detail}`);
  }
};

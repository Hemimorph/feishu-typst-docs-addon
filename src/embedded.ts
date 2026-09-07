export const MAX_EMBEDDED_FILE_BYTES = 4 * 1024 * 1024;
// Official Docs Add-on storage documentation gives both Record and Interaction
// a 500 KB total data quota. Count the complete serialized value, not raw files.
export const RECORD_QUOTA_BYTES = 500_000;

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

export const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export interface EncodedLocalFile {
  name: string;
  mime: string;
  size: number;
  data: string;
  sha256: string;
}

export const encodeLocalFile = async (file: File): Promise<EncodedLocalFile> => {
  if (file.size > MAX_EMBEDDED_FILE_BYTES) {
    throw new Error(
      `${file.name} 大于单文件嵌入上限 ${formatBytes(MAX_EMBEDDED_FILE_BYTES)}，请改用远程 URL`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: bytes.byteLength,
    data: bytesToBase64(bytes),
    sha256: bytesToHex(digest),
  };
};

export const serializedRecordBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const ensureRecordQuota = (value: unknown): number => {
  const bytes = serializedRecordBytes(value);
  if (bytes > RECORD_QUOTA_BYTES) {
    throw new Error(
      `gzip 后的组件 Record 为 ${formatBytes(bytes)}，仍超过飞书官方 500 KB 配额。请移除嵌入资源、改用远程 URL 或飞书图片句柄`,
    );
  }
  return bytes;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
};

export const formatQuotaBytes = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} B`;
  const kilobytes = bytes / 1000;
  return `${kilobytes < 10 ? kilobytes.toFixed(1) : kilobytes.toFixed(0)} KB`;
};

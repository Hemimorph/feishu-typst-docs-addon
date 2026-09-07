import { describe, expect, it } from 'vitest';
import {
  RECORD_QUOTA_BYTES,
  base64ToBytes,
  bytesToBase64,
  ensureRecordQuota,
  formatBytes,
  formatQuotaBytes,
  serializedRecordBytes,
} from './embedded';

describe('embedded resources', () => {
  it('round trips arbitrary bytes through JSON-safe base64', () => {
    const input = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    expect(base64ToBytes(bytesToBase64(input))).toEqual(input);
  });

  it('measures the serialized Record including Base64 expansion', () => {
    const value = { data: 'A'.repeat(1000), source: '你好' };
    expect(serializedRecordBytes(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  });

  it('enforces the documented 500 KB Record quota', () => {
    expect(() => ensureRecordQuota({ data: 'A'.repeat(RECORD_QUOTA_BYTES) })).toThrow(
      '500 KB',
    );
    expect(ensureRecordQuota({ data: 'small' })).toBeGreaterThan(0);
  });

  it('formats resource sizes for the editor', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MiB');
    expect(formatQuotaBytes(500_000)).toBe('500 KB');
    expect(formatQuotaBytes(9_500)).toBe('9.5 KB');
  });
});

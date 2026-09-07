import { describe, expect, it } from 'vitest';
import { makePdfFileName, validatePdfBytes } from './pdf';

describe('validatePdfBytes', () => {
  it('accepts a PDF header', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(validatePdfBytes(bytes)).toBe(bytes);
  });

  it('rejects an empty or invalid artifact', () => {
    expect(() => validatePdfBytes(new Uint8Array())).toThrow('无效的 PDF');
    expect(() => validatePdfBytes(new Uint8Array([1, 2, 3, 4, 5]))).toThrow('无效的 PDF');
  });
});

describe('makePdfFileName', () => {
  it('uses the Feishu document title', () => {
    expect(makePdfFileName('测试报告')).toBe('测试报告.pdf');
  });

  it('keeps an existing PDF extension', () => {
    expect(makePdfFileName('测试报告.PDF')).toBe('测试报告.PDF');
  });

  it('replaces unsafe characters and falls back for an empty title', () => {
    expect(makePdfFileName('测试/报告:最终版')).toBe('测试_报告_最终版.pdf');
    expect(makePdfFileName('  ')).toBe('Typst.pdf');
  });
});

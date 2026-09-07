const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

export const validatePdfBytes = (bytes: Uint8Array): Uint8Array => {
  if (
    bytes.length < PDF_SIGNATURE.length ||
    PDF_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    throw new Error('Typst 返回了无效的 PDF');
  }
  return bytes;
};

export const makePdfFileName = (documentTitle: string): string => {
  const safeTitle = documentTitle
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  const baseName = safeTitle || 'Typst';
  return baseName.toLowerCase().endsWith('.pdf') ? baseName : `${baseName}.pdf`;
};

export const downloadPdfBytes = (bytes: Uint8Array, documentTitle: string): void => {
  const pdf = validatePdfBytes(bytes);
  const buffer = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(buffer).set(pdf);
  const blob = new Blob([buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = makePdfFileName(documentTitle);
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

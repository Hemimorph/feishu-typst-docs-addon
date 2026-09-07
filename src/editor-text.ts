export interface TextInsertion {
  value: string;
  cursor: number;
}

const clampOffset = (value: number, length: number): number =>
  Math.min(Math.max(Number.isFinite(value) ? value : length, 0), length);

/** Insert a standalone Typst block at the current textarea selection. */
export const insertTypstBlock = (
  source: string,
  block: string,
  selectionStart: number,
  selectionEnd: number,
): TextInsertion => {
  const start = clampOffset(Math.min(selectionStart, selectionEnd), source.length);
  const end = clampOffset(Math.max(selectionStart, selectionEnd), source.length);
  const before = source.slice(0, start);
  const after = source.slice(end);
  const leadingBreak = before && !before.endsWith('\n') ? '\n' : '';
  const trailingBreak = after.startsWith('\n') ? '' : '\n';
  const insertion = `${leadingBreak}${block}${trailingBreak}`;

  return {
    value: `${before}${insertion}${after}`,
    cursor: before.length + insertion.length + (after.startsWith('\n') ? 1 : 0),
  };
};

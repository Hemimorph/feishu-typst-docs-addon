import { describe, expect, it } from 'vitest';
import { isRecordTooLargeError } from './error';

describe('isRecordTooLargeError', () => {
  it('recognizes the generic Feishu host error', () => {
    expect(
      isRecordTooLargeError(new Error('[10110005] Record.setRecord - record size is too large')),
    ).toBe(true);
  });

  it('does not hide unrelated save errors', () => {
    expect(isRecordTooLargeError(new Error('Not logged in'))).toBe(false);
  });
});

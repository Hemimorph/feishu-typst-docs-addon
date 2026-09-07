import { describe, expect, it } from 'vitest';
import { insertTypstBlock } from './editor-text';

describe('insertTypstBlock', () => {
  it('inserts at the cursor instead of appending to the document', () => {
    expect(insertTypstBlock('before\nafter', '#image("assets/logo.png")', 7, 7)).toEqual({
      value: 'before\n#image("assets/logo.png")\nafter',
      cursor: 33,
    });
  });

  it('turns an insertion in the middle of a line into a standalone block', () => {
    const result = insertTypstBlock('before after', '#image("assets/logo.png")', 6, 6);

    expect(result.value).toBe('before\n#image("assets/logo.png")\n after');
    expect(result.value.slice(result.cursor)).toBe(' after');
  });

  it('replaces the current selection and leaves the cursor after the inserted block', () => {
    const result = insertTypstBlock('before\nselected\nafter', '#image("assets/a.png")', 7, 15);

    expect(result.value).toBe('before\n#image("assets/a.png")\nafter');
    expect(result.value[result.cursor]).toBe('a');
  });

  it('appends with a final newline when the cursor is at the end', () => {
    expect(insertTypstBlock('before', '#image("assets/a.png")', 6, 6)).toEqual({
      value: 'before\n#image("assets/a.png")\n',
      cursor: 30,
    });
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('docs add-on sizing configuration', () => {
  it('keeps the inline block in automatic-height mode', () => {
    const appConfig = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    ) as {
      contributes?: { addPanel?: { resizeType?: string } };
    };

    expect(appConfig.contributes?.addPanel?.resizeType).toBe('none');
  });
});

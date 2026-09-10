import { describe, expect, it, vi } from 'vitest';
import { createHostReadyNotifier } from './app-ready';

describe('createHostReadyNotifier', () => {
  it('notifies immediately once without waiting for preview work', () => {
    const preview = new Promise<void>(() => undefined);
    const notify = vi.fn(async () => undefined);
    const report = vi.fn();
    const ready = createHostReadyNotifier(notify, report);

    ready();
    ready();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    expect(preview).toBeInstanceOf(Promise);
  });

  it('reports asynchronous notification failures without throwing', async () => {
    const failure = new Error('host unavailable');
    const report = vi.fn();
    const ready = createHostReadyNotifier(async () => Promise.reject(failure), report);

    expect(() => ready()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(report).toHaveBeenCalledWith(failure);
  });
});

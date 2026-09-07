import { describe, expect, it, vi } from 'vitest';
import { measureContentHeight, syncHostHeight, type HeightBridge } from './host-height';

const makeBridge = (heights: number[] = [802]) => {
  const updateHeight = vi.fn(async () => undefined);
  const updateResize = vi.fn(async () => undefined);
  const getContainerRect = vi.fn(async () => ({ height: heights.shift() ?? 802 }));
  return { updateHeight, updateResize, getContainerRect } satisfies HeightBridge;
};

describe('measureContentHeight', () => {
  it('uses the larger layout measurement and includes the host border allowance', () => {
    expect(
      measureContentHeight({
        scrollHeight: 799.2,
        getBoundingClientRect: () => ({ height: 800.1 }),
      }),
    ).toBe(803);
  });
});

describe('syncHostHeight', () => {
  it('uses updateHeight directly for a non-resizable block', async () => {
    const bridge = makeBridge();

    const result = await syncHostHeight(bridge, 802, false);

    expect(bridge.updateResize).not.toHaveBeenCalled();
    expect(bridge.updateHeight).toHaveBeenCalledWith(802);
    expect(result).toMatchObject({ actualHeight: 802, matched: true, migrated: false });
  });

  it('migrates an existing resizable block before updating its height', async () => {
    const bridge = makeBridge();

    const result = await syncHostHeight(bridge, 802, true);

    expect(bridge.updateResize).toHaveBeenCalledWith({ height: 802, resizeType: 'none' });
    expect(bridge.updateResize.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.updateHeight.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({ matched: true, migrated: true });
  });

  it('falls back to updateHeight when migration is unavailable', async () => {
    const bridge = makeBridge();
    const migrationError = new Error('unsupported');
    bridge.updateResize.mockRejectedValueOnce(migrationError);

    const result = await syncHostHeight(bridge, 802, true);

    expect(bridge.updateHeight).toHaveBeenCalledWith(802);
    expect(result.migrated).toBe(false);
    expect(result.migrationError).toBe(migrationError);
  });

  it('keeps the successful migration when the follow-up updateHeight is rejected', async () => {
    const bridge = makeBridge();
    bridge.updateHeight.mockRejectedValueOnce(new Error('host has already applied updateResize'));

    const result = await syncHostHeight(bridge, 802, true);

    expect(result).toMatchObject({ actualHeight: 802, matched: true, migrated: true });
  });

  it('surfaces updateHeight failures when no migration has succeeded', async () => {
    const bridge = makeBridge();
    const heightError = new Error('height update failed');
    bridge.updateHeight.mockRejectedValueOnce(heightError);

    await expect(syncHostHeight(bridge, 802, false)).rejects.toBe(heightError);
  });

  it('retries once when the host reports a stale height', async () => {
    const bridge = makeBridge([360, 802]);

    const result = await syncHostHeight(bridge, 802, false);

    expect(bridge.updateHeight).toHaveBeenCalledTimes(2);
    expect(bridge.getContainerRect).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ actualHeight: 802, matched: true });
  });
});

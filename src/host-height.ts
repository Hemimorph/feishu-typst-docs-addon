export interface HeightMeasurable {
  scrollHeight: number;
  getBoundingClientRect(): { height: number };
}

export interface HeightBridge {
  updateHeight(height?: number): Promise<void>;
  updateResize(resize: { height?: number; resizeType?: string }): Promise<void>;
  getContainerRect(): Promise<{ height: number }>;
}

export interface HeightSyncResult {
  requestedHeight: number;
  actualHeight?: number;
  matched?: boolean;
  migrated: boolean;
  migrationError?: unknown;
}

const HEIGHT_PADDING = 2;
const HEIGHT_TOLERANCE = 2;

export const measureContentHeight = (element: HeightMeasurable): number =>
  Math.ceil(Math.max(element.scrollHeight, element.getBoundingClientRect().height)) + HEIGHT_PADDING;

const readHostHeight = async (bridge: HeightBridge): Promise<number | undefined> => {
  try {
    return (await bridge.getContainerRect()).height;
  } catch {
    return undefined;
  }
};

const heightsMatch = (requested: number, actual: number): boolean =>
  Math.abs(requested - actual) <= HEIGHT_TOLERANCE;

export const syncHostHeight = async (
  bridge: HeightBridge,
  requestedHeight: number,
  migrateResizable: boolean,
): Promise<HeightSyncResult> => {
  let migrated = false;
  let migrationError: unknown;

  if (migrateResizable) {
    try {
      // Existing blocks created with resizeType=vertical retain collaborative
      // resize state. Migrate that state before using updateHeight.
      await bridge.updateResize({ height: requestedHeight, resizeType: 'none' });
      migrated = true;
    } catch (reason) {
      // updateResize is unavailable on mobile and can fail in read-only mode.
      // updateHeight remains the documented fallback for resizeType=none/mobile.
      migrationError = reason;
    }
  }

  try {
    await bridge.updateHeight(requestedHeight);
  } catch (reason) {
    if (!migrated) throw reason;
  }

  let actualHeight = await readHostHeight(bridge);
  if (actualHeight !== undefined && !heightsMatch(requestedHeight, actualHeight)) {
    // A host resize can settle one task later. Retry once, then expose the
    // measured mismatch to diagnostics instead of creating an update loop.
    await bridge.updateHeight(requestedHeight);
    actualHeight = await readHostHeight(bridge);
  }

  return {
    requestedHeight,
    actualHeight,
    matched: actualHeight === undefined ? undefined : heightsMatch(requestedHeight, actualHeight),
    migrated,
    migrationError,
  };
};

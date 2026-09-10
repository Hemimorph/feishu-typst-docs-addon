export const createHostReadyNotifier = (
  notify: () => Promise<unknown>,
  onError: (reason: unknown) => void,
): (() => void) => {
  let invoked = false;
  return () => {
    if (invoked) return;
    invoked = true;
    try {
      void notify().catch(onError);
    } catch (reason) {
      onError(reason);
    }
  };
};

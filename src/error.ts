export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return '未知错误';
  }
};

export const isRecordTooLargeError = (error: unknown): boolean =>
  /record(?:\.setRecord)?\s*-?\s*record size is too large/i.test(errorMessage(error));

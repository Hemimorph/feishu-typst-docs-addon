import type { RecordData } from '@lark-opdev/block-docs-addon-api';
import { docsApi } from './feishu';
import type { TypstAddonRecord } from './model';
import { ensureCompressedRecordQuota, unpackAddonRecord } from './record-codec';

export class RecordConflictError extends Error {
  constructor() {
    super('内容已被其他协作者修改，请重新打开编辑器后再保存。');
    this.name = 'RecordConflictError';
  }
}

export const readAddonRecord = async (): Promise<TypstAddonRecord> =>
  unpackAddonRecord(await docsApi.Record.getRecord());

export const saveAddonRecord = async (
  draft: TypstAddonRecord,
  expectedVersion: number,
): Promise<TypstAddonRecord> => {
  const rawCurrent = await docsApi.Record.getRecord();
  const current = await unpackAddonRecord(rawCurrent);

  if (current.version !== expectedVersion) {
    throw new RecordConflictError();
  }

  const next: TypstAddonRecord = {
    ...draft,
    schemaVersion: 1,
    version: current.version + 1,
  };

  const packed = await ensureCompressedRecordQuota(next);

  await docsApi.Record.applyTransaction((operation) => {
    operation.replace([], packed);
  });

  return next;
};

export const fromRecordData = (record: RecordData): Promise<TypstAddonRecord> =>
  unpackAddonRecord(record);

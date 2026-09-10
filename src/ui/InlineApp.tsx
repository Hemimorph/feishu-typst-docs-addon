import { useCallback, useEffect, useRef, useState } from 'react';
import { DOCS_MODE, type RecordData } from '@lark-opdev/block-docs-addon-api';
import { docsApi } from '../feishu';
import { createHostReadyNotifier } from '../app-ready';
import { errorMessage } from '../error';
import { measureContentHeight, syncHostHeight } from '../host-height';
import { DEFAULT_RECORD, type TypstAddonRecord } from '../model';
import { downloadPdfBytes } from '../pdf';
import { fromRecordData, readAddonRecord } from '../record';
import { TypstPreview } from './TypstPreview';
import { useFeishuTheme } from './useFeishuTheme';

export const InlineApp = () => {
  useFeishuTheme();
  const containerRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(true);
  const resizeMigrationAttemptedRef = useRef(false);
  const heightSyncQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [record, setRecord] = useState<TypstAddonRecord>(DEFAULT_RECORD);
  const [recordLoaded, setRecordLoaded] = useState(false);
  const [heightSyncEnabled, setHeightSyncEnabled] = useState(false);
  const [error, setError] = useState<string>();
  const [canEdit, setCanEdit] = useState(true);
  const [opening, setOpening] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const notifyHostReady = createHostReadyNotifier(
      () => docsApi.LifeCycle.notifyAppReady(),
      (reason) => {
        if (mountedRef.current) {
          setError(`通知飞书组件就绪失败：${errorMessage(reason)}`);
        }
      },
    );
    // Host loading only covers the iframe boot. Typst resources may still be
    // downloading; the mounted UI reports that work with its own progress bar.
    notifyHostReady();
  }, []);

  useEffect(() => {
    let alive = true;
    let editableByPermission = true;
    let recordChangeSequence = 0;
    let recordSubscribed = false;
    let modeSubscribed = false;
    const onRecordChange = (value: RecordData) => {
      const sequence = ++recordChangeSequence;
      void fromRecordData(value)
        .then((incoming) => {
          if (alive && sequence === recordChangeSequence) {
            setRecord(incoming);
            setError(undefined);
          }
        })
        .catch((reason) => {
          if (alive && sequence === recordChangeSequence) setError(errorMessage(reason));
        });
    };
    const onModeChange = (mode: DOCS_MODE) => {
      if (alive) setCanEdit(editableByPermission && mode === DOCS_MODE.EDITING);
    };
    const unsubscribeRecord = async () => {
      if (!recordSubscribed) return;
      recordSubscribed = false;
      try {
        await docsApi.Record.offRecordChange(onRecordChange);
      } catch (reason) {
        console.info('取消飞书 Record 监听失败', reason);
      }
    };
    const unsubscribeMode = async () => {
      if (!modeSubscribed) return;
      modeSubscribed = false;
      try {
        await docsApi.Env.DocsMode.offDocsModeChange(onModeChange);
      } catch (reason) {
        console.info('取消飞书文档模式监听失败', reason);
      }
    };

    (async () => {
      try {
        const [initialRecord, docRef, mode] = await Promise.all([
          readAddonRecord(),
          docsApi.getActiveDocumentRef(),
          docsApi.Env.DocsMode.getDocsMode(),
        ]);
        const permission = await docsApi.Service.Permission.getDocumentPermission(docRef);
        editableByPermission = permission.editable;
        if (!alive) return;
        setRecord(initialRecord);
        setRecordLoaded(true);
        setCanEdit(permission.editable && mode === DOCS_MODE.EDITING);
        await docsApi.Record.onRecordChange(onRecordChange);
        recordSubscribed = true;
        if (!alive) {
          await unsubscribeRecord();
          return;
        }
        await docsApi.Env.DocsMode.onDocsModeChange(onModeChange);
        modeSubscribed = true;
        if (!alive) await unsubscribeMode();
      } catch (reason) {
        if (alive) {
          setError(errorMessage(reason));
          setRecordLoaded(true);
        }
      }
    })();

    return () => {
      alive = false;
      void unsubscribeRecord();
      void unsubscribeMode();
    };
  }, []);

  const updateHostHeight = useCallback(
    (allowMigration = false) => {
      const migrateResizable =
        allowMigration && canEdit && !resizeMigrationAttemptedRef.current;
      if (migrateResizable) resizeMigrationAttemptedRef.current = true;

      const task = heightSyncQueueRef.current.then(async () => {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
        });
        const container = containerRef.current;
        if (!container) return;

        const result = await syncHostHeight(
          docsApi.Bridge,
          measureContentHeight(container),
          migrateResizable,
        );
        if (result.migrationError) {
          console.info('Typst host resize migration was unavailable; used updateHeight.', {
            reason: errorMessage(result.migrationError),
          });
        }
        if (result.matched === false) {
          console.warn('Typst host height does not match rendered content.', result);
        }
      });

      heightSyncQueueRef.current = task.catch(() => undefined);
      return task;
    },
    [canEdit],
  );

  const handlePreviewSettled = useCallback(() => {
    if (!mountedRef.current) return;
    setHeightSyncEnabled(true);
    void updateHostHeight(true).catch((reason) => {
      if (mountedRef.current) setError(errorMessage(reason));
    });
  }, [updateHostHeight]);

  useEffect(() => {
    if (!heightSyncEnabled) return;
    const container = containerRef.current;
    if (!container) return;

    let animationFrame = 0;
    let followUp = 0;
    const updateHeight = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        void updateHostHeight().catch(() => undefined);
      });
    };
    const updateHeightTwice = () => {
      updateHeight();
      window.clearTimeout(followUp);
      followUp = window.setTimeout(updateHeight, 100);
    };

    const resizeObserver = new ResizeObserver(updateHeightTwice);
    const mutationObserver = new MutationObserver(updateHeightTwice);
    resizeObserver.observe(container);
    mutationObserver.observe(container, { childList: true, subtree: true });
    updateHeightTwice();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(followUp);
    };
  }, [heightSyncEnabled, updateHostHeight]);

  useEffect(() => {
    if (!heightSyncEnabled || !canEdit || resizeMigrationAttemptedRef.current) return;
    void updateHostHeight(true).catch(() => undefined);
  }, [canEdit, heightSyncEnabled, updateHostHeight]);

  const openEditor = async () => {
    setOpening(true);
    setError(undefined);
    try {
      await docsApi.View.Action.openModal({
        title: '编辑 Typst',
        width: 1180,
        data: { version: record.version },
      });
      const nextRecord = await readAddonRecord();
      if (mountedRef.current) setRecord(nextRecord);
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason));
    } finally {
      if (mountedRef.current) setOpening(false);
    }
  };

  const downloadPdf = async () => {
    setDownloading(true);
    setError(undefined);
    try {
      const pdfPromise = import('../typst').then(({ renderTypstPdf }) => renderTypstPdf(record));
      const titlePromise = docsApi
        .getActiveDocumentRef()
        .then((docRef) => docsApi.Document.getTitle(docRef))
        .catch(() => 'Typst');
      const [pdf, title] = await Promise.all([pdfPromise, titlePromise]);
      if (mountedRef.current) downloadPdfBytes(pdf, title);
    } catch (reason) {
      if (mountedRef.current) setError(`PDF 下载失败：${errorMessage(reason)}`);
    } finally {
      if (mountedRef.current) setDownloading(false);
    }
  };

  return (
    <main ref={containerRef} className="inline-app">
      <header className="inline-toolbar">
        <div>
          <strong>Typst</strong>
          <span className="muted">实时预览</span>
        </div>
        <div className="toolbar-actions">
          <button
            className="button"
            disabled={!recordLoaded || !record.source.trim() || downloading}
            onClick={downloadPdf}
          >
            {downloading ? '正在生成…' : '下载 PDF'}
          </button>
          <button className="button primary" disabled={!canEdit || opening} onClick={openEditor}>
            {opening ? '正在打开…' : canEdit ? '编辑' : '只读'}
          </button>
        </div>
      </header>
      {recordLoaded ? (
        <TypstPreview record={record} onSettled={handlePreviewSettled} />
      ) : (
        <div className="preview-shell">
          <div className="preview-loading">正在载入 Typst…</div>
        </div>
      )}
      {error ? <div className="inline-error">{error}</div> : null}
    </main>
  );
};

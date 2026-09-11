import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  BlockType,
  DOCS_MODE,
  type BlockSnapshot,
  type ImageBlockSnapshot,
  type RecordData,
} from '@lark-opdev/block-docs-addon-api';
import { docsApi } from '../feishu';
import {
  RECORD_QUOTA_BYTES,
  encodeLocalFile,
  formatBytes,
  formatQuotaBytes,
} from '../embedded';
import { insertTypstBlock } from '../editor-text';
import { errorMessage, isRecordTooLargeError } from '../error';
import {
  BUILTIN_TYPST_FONTS,
  findUnavailableLiteralFonts,
  mergeFontCatalog,
  type AvailableTypstFont,
} from '../fonts';
import {
  DEFAULT_RECORD,
  type EmbeddedFontAsset,
  type EmbeddedImageAsset,
  makeAssetId,
  normalizeAssetPath,
  normalizeImageAssets,
  type FeishuImageAsset,
  type RemoteImageAsset,
  type TypstAddonRecord,
  type TypstImageAsset,
} from '../model';
import { fromRecordData, readAddonRecord, saveAddonRecord } from '../record';
import { compressedRecordBytes, ensureCompressedRecordQuota } from '../record-codec';
import { TypstPreview } from './TypstPreview';
import type { TypstSourceEditorHandle } from './TypstSourceEditor';
import { useFeishuTheme } from './useFeishuTheme';

const TypstSourceEditor = lazy(() =>
  import('./TypstSourceEditor').then((module) => ({ default: module.TypstSourceEditor })),
);

const collectImageBlocks = (root: BlockSnapshot): ImageBlockSnapshot[] => {
  const images: ImageBlockSnapshot[] = [];
  const visit = (block: BlockSnapshot) => {
    if (block.type === BlockType.IMAGE) images.push(block as ImageBlockSnapshot);
    block.childSnapshots.forEach(visit);
  };
  visit(root);
  return images;
};

const suggestedRemotePath = (url: string): string => {
  try {
    const pathname = new URL(url).pathname;
    const filename = decodeURIComponent(pathname.split('/').pop() || 'remote-image.png');
    return filename.includes('.') ? filename : `${filename}.png`;
  } catch {
    return 'remote-image.png';
  }
};

const parseFontSources = (value: string): string[] =>
  value
    .split('\n')
    .map((font) => font.trim())
    .filter(Boolean);

const uniqueAssetPath = (name: string, usedPaths: Set<string>): string => {
  const safeName = normalizeAssetPath(name || 'embedded-image.image');
  if (!usedPaths.has(safeName)) return safeName;
  const dot = safeName.lastIndexOf('.');
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : '';
  let suffix = 2;
  while (usedPaths.has(`${stem}-${suffix}${extension}`)) suffix += 1;
  return `${stem}-${suffix}${extension}`;
};

export const EditorApp = () => {
  useFeishuTheme();
  const [draft, setDraft] = useState<TypstAddonRecord>(DEFAULT_RECORD);
  const [baseVersion, setBaseVersion] = useState(0);
  const [fontsText, setFontsText] = useState('');
  const [availableFonts, setAvailableFonts] = useState<AvailableTypstFont[]>(() =>
    mergeFontCatalog(BUILTIN_TYPST_FONTS),
  );
  const [fontCatalogStatus, setFontCatalogStatus] = useState<'loading' | 'ready' | 'error'>(
    'ready',
  );
  const [fontMessage, setFontMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  }>();
  const [fontReload, setFontReload] = useState(0);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [documentImages, setDocumentImages] = useState<ImageBlockSnapshot[]>([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [imageMessage, setImageMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  }>();
  const [saving, setSaving] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string }>();
  const [recordDataBytes, setRecordDataBytes] = useState(0);
  const [quotaCalculating, setQuotaCalculating] = useState(true);
  const [quotaError, setQuotaError] = useState<string>();
  const loaded = useRef(false);
  const sourceEditorRef = useRef<TypstSourceEditorHandle>(null);
  const baseVersionRef = useRef(0);
  const dirtyRef = useRef(false);
  const assetListRef = useRef<HTMLDivElement>(null);
  const fontRequestId = useRef(0);
  const quotaRequestId = useRef(0);
  const mountedRef = useRef(true);
  const appliedFontsKey = JSON.stringify(draft.fonts);
  const embeddedFontsKey = JSON.stringify(
    draft.embeddedFonts.map((font) => [font.id, font.sha256, font.size]),
  );
  const embeddedTotalBytes = useMemo(
    () =>
      draft.embeddedFonts.reduce((total, font) => total + font.size, 0) +
      draft.images.reduce(
        (total, image) => total + (image.source === 'embedded' ? image.size : 0),
        0,
      ),
    [draft.embeddedFonts, draft.images],
  );
  const recordUsagePercent = (recordDataBytes / RECORD_QUOTA_BYTES) * 100;
  const recordRemainingBytes = Math.max(0, RECORD_QUOTA_BYTES - recordDataBytes);
  const recordOverQuota = recordDataBytes > RECORD_QUOTA_BYTES || Boolean(quotaError);
  const quotaLevel = recordOverQuota ? 'error' : recordUsagePercent >= 80 ? 'warning' : 'normal';
  const unavailableFonts = useMemo(
    () =>
      fontCatalogStatus === 'loading'
        ? []
        : findUnavailableLiteralFonts(draft.source, availableFonts),
    [availableFonts, draft.source, fontCatalogStatus],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
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
          if (
            !alive ||
            sequence !== recordChangeSequence ||
            !loaded.current ||
            incoming.version === baseVersionRef.current
          ) return;
          if (dirtyRef.current) {
            setConflicted(true);
            return;
          }
          setDraft(incoming);
          setFontsText(incoming.fonts.join('\n'));
          setBaseVersion(incoming.version);
          baseVersionRef.current = incoming.version;
        })
        .catch((reason) => {
          if (alive && sequence === recordChangeSequence) {
            setMessage({ type: 'error', text: errorMessage(reason) });
          }
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
        const [record, docRef, mode] = await Promise.all([
          readAddonRecord(),
          docsApi.getActiveDocumentRef(),
          docsApi.Env.DocsMode.getDocsMode(),
        ]);
        const permission = await docsApi.Service.Permission.getDocumentPermission(docRef);
        editableByPermission = permission.editable;
        if (!alive) return;
        setDraft(record);
        setFontsText(record.fonts.join('\n'));
        setBaseVersion(record.version);
        baseVersionRef.current = record.version;
        setCanEdit(permission.editable && mode === DOCS_MODE.EDITING);
        loaded.current = true;
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
        if (alive) setMessage({ type: 'error', text: errorMessage(reason) });
      }
    })();

    return () => {
      alive = false;
      loaded.current = false;
      void unsubscribeRecord();
      void unsubscribeMode();
    };
  }, []);

  useEffect(() => {
    const currentRequest = ++fontRequestId.current;
    const fonts = [...draft.fonts];
    const embeddedFonts = [...draft.embeddedFonts];
    setFontCatalogStatus('loading');
    setFontMessage(undefined);

    import('../typst')
      .then(({ getAvailableTypstFonts }) =>
        getAvailableTypstFonts({ ...DEFAULT_RECORD, fonts, embeddedFonts }),
      )
      .then((catalog) => {
        if (fontRequestId.current !== currentRequest) return;
        setAvailableFonts(catalog);
        setFontCatalogStatus('ready');
        if (fonts.length || embeddedFonts.length) {
          const customFamilyCount = catalog.filter((font) => font.customUrls.length).length;
          setFontMessage({
            type: 'success',
            text: `字体已应用：扫描 ${fonts.length} 个字体资源、${embeddedFonts.length} 个嵌入文件，识别出 ${customFamilyCount} 个自定义字族。`,
          });
        }
      })
      .catch((reason) => {
        if (fontRequestId.current !== currentRequest) return;
        setAvailableFonts(mergeFontCatalog(BUILTIN_TYPST_FONTS));
        setFontCatalogStatus('error');
        setFontMessage({ type: 'error', text: errorMessage(reason) });
      });

    return () => {
      if (fontRequestId.current === currentRequest) fontRequestId.current += 1;
    };
  }, [appliedFontsKey, embeddedFontsKey, fontReload]);

  useEffect(() => {
    const currentRequest = ++quotaRequestId.current;
    setQuotaCalculating(true);
    const timer = window.setTimeout(() => {
      compressedRecordBytes({ ...draft, fonts: parseFontSources(fontsText) })
        .then((bytes) => {
          if (quotaRequestId.current !== currentRequest) return;
          setRecordDataBytes(bytes);
          setQuotaError(undefined);
        })
        .catch((reason) => {
          if (quotaRequestId.current !== currentRequest) return;
          setQuotaError(errorMessage(reason));
        })
        .finally(() => {
          if (quotaRequestId.current === currentRequest) setQuotaCalculating(false);
        });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      if (quotaRequestId.current === currentRequest) quotaRequestId.current += 1;
    };
  }, [draft, fontsText]);

  const updateDraft = (updater: (current: TypstAddonRecord) => TypstAddonRecord) => {
    setDraft(updater);
    setDirty(true);
    dirtyRef.current = true;
    setMessage(undefined);
  };

  const updateFonts = (value: string) => {
    setFontsText(value);
    setDirty(true);
    dirtyRef.current = true;
    setMessage(undefined);
    setFontMessage(undefined);
  };

  const addEmbeddedFonts = async (files: File[]) => {
    if (!files.length || !canEdit || !mountedRef.current) return;
    setFontCatalogStatus('loading');
    setFontMessage(undefined);
    try {
      const pending: EmbeddedFontAsset[] = [];
      for (const file of files) {
        if (!/\.(ttf|otf|ttc|woff)$/i.test(file.name)) {
          throw new Error(`${file.name} 不是支持的字体文件；请选择 TTF、OTF、TTC 或 WOFF`);
        }
        const encoded = await encodeLocalFile(file);
        if (!mountedRef.current) return;
        const duplicate = [...draft.embeddedFonts, ...pending].some(
          (font) => font.sha256 === encoded.sha256,
        );
        if (duplicate) continue;
        const asset = { id: makeAssetId(), ...encoded };
        await ensureCompressedRecordQuota({
          ...draft,
          fonts: parseFontSources(fontsText),
          embeddedFonts: [...draft.embeddedFonts, ...pending, asset],
        });
        if (!mountedRef.current) return;
        pending.push(asset);
      }
      if (!mountedRef.current) return;
      if (!pending.length) {
        setFontCatalogStatus('ready');
        setFontMessage({ type: 'success', text: '所选字体已经嵌入，无需重复添加。' });
        return;
      }
      updateDraft((current) => ({
        ...current,
        embeddedFonts: [...current.embeddedFonts, ...pending],
      }));
      setFontMessage({
        type: 'success',
        text: `已嵌入 ${pending.length} 个字体文件，正在读取内部字族名…`,
      });
    } catch (reason) {
      if (mountedRef.current) {
        setFontCatalogStatus('error');
        setFontMessage({ type: 'error', text: errorMessage(reason) });
      }
    }
  };

  const removeEmbeddedFont = (id: string) =>
    updateDraft((current) => ({
      ...current,
      embeddedFonts: current.embeddedFonts.filter((font) => font.id !== id),
    }));

  const addEmbeddedImages = async (files: File[]) => {
    if (!files.length || !canEdit || !mountedRef.current) return;
    setImageMessage(undefined);
    try {
      const pending: EmbeddedImageAsset[] = [];
      const usedPaths = new Set(draft.images.map((image) => normalizeAssetPath(image.path)));
      for (const file of files) {
        if (!file.type.startsWith('image/')) {
          throw new Error(`${file.name} 不是浏览器可识别的图片文件`);
        }
        const encoded = await encodeLocalFile(file);
        if (!mountedRef.current) return;
        const duplicate = [...draft.images, ...pending].some(
          (image) => image.source === 'embedded' && image.sha256 === encoded.sha256,
        );
        if (duplicate) continue;
        const path = uniqueAssetPath(file.name, usedPaths);
        usedPaths.add(path);
        const asset: EmbeddedImageAsset = {
          id: makeAssetId(),
          source: 'embedded',
          path,
          ...encoded,
        };
        await ensureCompressedRecordQuota({
          ...draft,
          fonts: parseFontSources(fontsText),
          images: [...draft.images, ...pending, asset],
        });
        if (!mountedRef.current) return;
        pending.push(asset);
      }
      if (!mountedRef.current) return;
      if (!pending.length) {
        setImageMessage({ type: 'success', text: '所选图片已经嵌入，无需重复添加。' });
        return;
      }
      updateDraft((current) => ({ ...current, images: [...current.images, ...pending] }));
      setImageMessage({
        type: 'success',
        text: `已按原文件嵌入 ${pending.length} 张图片。请在资源列表点击“插入代码”。`,
      });
      window.requestAnimationFrame(() => {
        assetListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } catch (reason) {
      if (mountedRef.current) setImageMessage({ type: 'error', text: errorMessage(reason) });
    }
  };

  const addRemoteImage = () => {
    try {
      const url = new URL(remoteUrl);
      if (url.protocol !== 'https:') throw new Error('远程图片只支持 HTTPS URL');
      const path = normalizeAssetPath(remotePath || suggestedRemotePath(remoteUrl));
      if (draft.images.some((image) => normalizeAssetPath(image.path) === path)) {
        throw new Error(`图片资源路径重复：assets/${path}`);
      }
      const asset: RemoteImageAsset = {
        id: makeAssetId(),
        source: 'remote',
        path,
        url: url.toString(),
      };
      updateDraft((current) => ({ ...current, images: [...current.images, asset] }));
      setRemoteUrl('');
      setRemotePath('');
    } catch (reason) {
      setMessage({ type: 'error', text: errorMessage(reason) });
    }
  };

  const scanDocumentImages = async () => {
    if (!mountedRef.current) return;
    setLoadingImages(true);
    setMessage(undefined);
    setImageMessage(undefined);
    try {
      const docRef = await docsApi.getActiveDocumentRef();
      const root = await docsApi.Document.getRootBlock(docRef);
      const images = collectImageBlocks(root);
      if (!mountedRef.current) return;
      setDocumentImages(images);
      if (!images.length) {
        setImageMessage({ type: 'error', text: '当前文档中没有找到图片块。' });
      }
    } catch (reason) {
      if (mountedRef.current) {
        setImageMessage({ type: 'error', text: `扫描文档图片失败：${errorMessage(reason)}` });
      }
    } finally {
      if (mountedRef.current) setLoadingImages(false);
    }
  };

  const addDocumentImage = (block: ImageBlockSnapshot) => {
    const alreadyAdded = draft.images.some(
      (image) =>
        image.source === 'feishu' &&
        image.docToken === block.ref.docRef.docToken &&
        image.blockId === block.id,
    );
    if (alreadyAdded) {
      setImageMessage({ type: 'success', text: `图片块 #${block.id} 已在下方资源列表中。` });
      assetListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    setImageMessage(undefined);
    try {
      // Register the block immediately. Reading the binary here can be slow or
      // unavailable in a modal; the preview/PDF pipeline fetches it on demand.
      // An unknown extension makes Typst detect the actual format from bytes;
      // pretending every document image is PNG breaks JPEG/SVG images.
      const usedPaths = new Set(draft.images.map((image) => normalizeAssetPath(image.path)));
      let path = normalizeAssetPath(`document-${block.id}.image`);
      let suffix = 2;
      while (usedPaths.has(path)) {
        path = normalizeAssetPath(`document-${block.id}-${suffix}.image`);
        suffix += 1;
      }
      const asset: FeishuImageAsset = {
        id: makeAssetId(),
        source: 'feishu',
        path,
        docToken: block.ref.docRef.docToken,
        blockId: block.id,
        imageToken: block.data.token,
      };
      updateDraft((current) => {
        const alreadyAdded = current.images.some(
          (image) =>
            image.source === 'feishu' &&
            image.docToken === asset.docToken &&
            image.blockId === asset.blockId,
        );
        return alreadyAdded ? current : { ...current, images: [...current.images, asset] };
      });
      setImageMessage({
        type: 'success',
        text: `已添加图片块 #${block.id}。请在下方点击“插入代码”，然后保存。`,
      });
      window.requestAnimationFrame(() => {
        assetListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } catch (reason) {
      setImageMessage({ type: 'error', text: `添加飞书图片失败：${errorMessage(reason)}` });
    }
  };

  const removeImage = (id: string) =>
    updateDraft((current) => ({
      ...current,
      images: current.images.filter((image) => image.id !== id),
    }));

  const updateImagePath = (id: string, path: string) =>
    updateDraft((current) => ({
      ...current,
      images: current.images.map((image) => (image.id === id ? { ...image, path } : image)),
    }));

  const insertImageCode = (image: TypstImageAsset) => {
    try {
      const path = normalizeAssetPath(image.path);
      const snippet = `#image("assets/${path}")`;
      const editor = sourceEditorRef.current;
      const selectionStart = editor?.selectionStart ?? draft.source.length;
      const selectionEnd = editor?.selectionEnd ?? selectionStart;
      const insertion = insertTypstBlock(
        draft.source,
        snippet,
        selectionStart,
        selectionEnd,
      );
      updateDraft((current) => ({
        ...current,
        images: current.images.map((item) => (item.id === image.id ? { ...item, path } : item)),
        source: insertion.value,
      }));
      setImageMessage({
        type: 'success',
        text: `已在光标位置插入 ${snippet}，点击右上角“保存”后生效。`,
      });
      window.requestAnimationFrame(() => {
        editor?.focus({ preventScroll: true });
        editor?.setSelectionRange(insertion.cursor, insertion.cursor);
      });
    } catch (reason) {
      setImageMessage({ type: 'error', text: errorMessage(reason) });
    }
  };

  const applyFontsToPreview = () => {
    setDraft((current) => ({ ...current, fonts: parseFontSources(fontsText) }));
    setFontReload((current) => current + 1);
    setMessage(undefined);
    setFontMessage(undefined);
  };

  const save = async () => {
    if (!canEdit || !mountedRef.current) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const fonts = parseFontSources(fontsText);
      const images = normalizeImageAssets(draft.images);
      const nextRecord = { ...draft, fonts, images };
      const saved = await saveAddonRecord(nextRecord, baseVersion);
      if (!mountedRef.current) return;
      setDraft(saved);
      setBaseVersion(saved.version);
      baseVersionRef.current = saved.version;
      setDirty(false);
      dirtyRef.current = false;
      setConflicted(false);
      await docsApi.View.Action.closeModal({ saved: true, version: saved.version });
    } catch (reason) {
      if (mountedRef.current) {
        setMessage({
          type: 'error',
          text: isRecordTooLargeError(reason)
            ? `飞书拒绝保存 gzip 后约 ${formatBytes(recordDataBytes)} 的 Record 数据；资源仍保持原始质量，请移除嵌入资源或使用远程 URL。`
            : errorMessage(reason),
        });
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const close = () => void docsApi.View.Action.closeModal({ saved: false, dirty });

  return (
    <main className="editor-app">
      <header className="editor-toolbar">
        <div>
          <strong>Typst 编辑器</strong>
          <span className="muted">字体与图片按需加载</span>
        </div>
        <div className="toolbar-actions">
          <button className="button" onClick={close}>关闭</button>
          <button
            className="button primary"
            disabled={!canEdit || saving || conflicted || quotaCalculating || recordOverQuota}
            onClick={save}
          >
            {saving
              ? '保存中…'
              : !canEdit
                ? '只读'
                : quotaCalculating
                  ? '计算配额…'
                  : recordOverQuota
                    ? '超出配额'
                    : '保存'}
          </button>
        </div>
      </header>

      {conflicted ? (
        <div className="notice error">内容已被其他协作者修改。请关闭并重新打开编辑器，避免覆盖对方的修改。</div>
      ) : null}
      {message ? <div className={`notice ${message.type}`}>{message.text}</div> : null}
      {recordOverQuota && !quotaCalculating ? (
        <div className="notice error">
          {quotaError ?? '压缩后的 Record 仍超过官方 500 KB 配额，需移除嵌入资源后才能保存。'}
        </div>
      ) : null}

      <section className="editor-grid">
        <div className="source-pane">
          <span className="field-label" id="typst-source-label">Typst 源码</span>
          <Suspense
            fallback={(
              <div className="source-editor source-editor-loading" role="status">
                正在加载语法高亮…
              </div>
            )}
          >
            <TypstSourceEditor
              ref={sourceEditorRef}
              labelledBy="typst-source-label"
              value={draft.source}
              onChange={(source) =>
                updateDraft((current) => ({ ...current, source }))
              }
            />
          </Suspense>
        </div>
        <div className="result-pane">
          <span className="field-label">实时预览</span>
          <TypstPreview record={draft} />
        </div>
      </section>

      <section className="resources-panel">
        <div className={`record-quota ${quotaLevel}`} role="status">
          <div className="record-quota-heading">
            <strong>组件存储配额</strong>
            <span>
              {quotaCalculating
                ? '正在计算 gzip 后占用…'
                : `${formatQuotaBytes(recordDataBytes)} / ${formatQuotaBytes(RECORD_QUOTA_BYTES)} · ${recordUsagePercent.toFixed(1)}%`}
            </span>
          </div>
          <div
            className="record-quota-track"
            role="progressbar"
            aria-label="组件 Record 配额使用程度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(recordUsagePercent))}
          >
            <span style={{ width: `${Math.min(recordUsagePercent, 100)}%` }} />
          </div>
          <div className="record-quota-details">
            <span>
              {quotaCalculating
                ? '等待最新数据'
                : recordOverQuota
                ? `已超出 ${formatQuotaBytes(recordDataBytes - RECORD_QUOTA_BYTES)}`
                : `剩余 ${formatQuotaBytes(recordRemainingBytes)}`}
            </span>
            <span>内嵌原文件 {formatBytes(embeddedTotalBytes)}</span>
          </div>
        </div>
        <div className="resource-section">
          <div className="section-heading">
            <div>
              <h2>字体</h2>
              <p>每行一个 HTTPS 字体资源或 Nix outPath；压缩包和 Nix 输出中的字体会被全部扫描，暂不支持 WOFF2。</p>
            </div>
            <div className="resource-actions">
              <label className="button file-button">
                上传并嵌入字体
                <input
                  type="file"
                  multiple
                  accept=".ttf,.otf,.ttc,.woff,font/ttf,font/otf,font/collection,font/woff"
                  disabled={!canEdit}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    void addEmbeddedFonts(Array.from(input.files ?? [])).finally(() => {
                      input.value = '';
                    });
                  }}
                />
              </label>
              <button
                className="button"
                disabled={fontCatalogStatus === 'loading'}
                onClick={applyFontsToPreview}
              >
                {fontCatalogStatus === 'loading' ? '正在加载…' : '应用到预览'}
              </button>
            </div>
          </div>
          <textarea
            className="url-list"
            value={fontsText}
            placeholder={'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-font-name-version\nhttps://cdn.example.com/fonts/family.zip'}
            onChange={(event) => updateFonts(event.target.value)}
          />
          {draft.embeddedFonts.length ? (
            <div className="embedded-file-list">
              {draft.embeddedFonts.map((font) => (
                <div className="embedded-file" key={font.id}>
                  <span className="source-badge embedded">嵌入</span>
                  <span title={font.name}>{font.name}</span>
                  <small>{formatBytes(font.size)}</small>
                  <button className="text-button danger" onClick={() => removeEmbeddedFont(font.id)}>
                    移除
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {fontMessage ? (
            <div className={`resource-feedback ${fontMessage.type}`} role="status">
              {fontMessage.text}
            </div>
          ) : null}
          <div className="font-catalog" aria-live="polite">
            <div className="font-catalog-heading">
              <strong>当前所有可用字体</strong>
              <span>{availableFonts.length} 个字族</span>
            </div>
            <p className="font-catalog-help">
              源码中的 <code>font:</code> 必须使用下面显示的完整字族名；名称不存在时 Typst 会静默回退。
            </p>
            {unavailableFonts.length ? (
              <div className="font-warning" role="alert">
                未加载这些源码字体，将使用回退字体：{unavailableFonts.join('、')}
              </div>
            ) : null}
            <div className="font-family-list">
              {availableFonts.map((font) => (
                <div className="font-family" key={font.family}>
                  <code>{font.family}</code>
                  <span>
                    {font.builtIn ? '内置' : '自定义'}
                    {font.builtIn && font.customUrls.length ? '＋自定义' : ''}
                    {' · '}{font.variants.join(' / ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="resource-section">
          <div className="section-heading">
            <div>
              <h2>图片资源</h2>
              <p>嵌入文件、远程 URL 和飞书图片块都会映射到 assets/；引用飞书图片时会尝试 getImageData。</p>
            </div>
            <label className="button file-button">
              上传并嵌入图片
              <input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                disabled={!canEdit}
                onChange={(event) => {
                  const input = event.currentTarget;
                  void addEmbeddedImages(Array.from(input.files ?? [])).finally(() => {
                    input.value = '';
                  });
                }}
              />
            </label>
          </div>

          <div className="remote-form">
            <input
              value={remoteUrl}
              placeholder="https://example.com/image.png"
              aria-label="远程图片 URL"
              onChange={(event) => {
                setRemoteUrl(event.target.value);
                if (!remotePath) setRemotePath(suggestedRemotePath(event.target.value));
              }}
            />
            <input
              value={remotePath}
              placeholder="figures/image.png"
              aria-label="Typst 图片路径"
              onChange={(event) => setRemotePath(event.target.value)}
            />
            <button className="button" onClick={addRemoteImage}>添加 URL</button>
          </div>

          <div className="document-image-picker">
            <button className="button" disabled={loadingImages} onClick={scanDocumentImages}>
              {loadingImages ? '正在扫描…' : '扫描并尝试读取飞书图片'}
            </button>
            {documentImages.length ? (
              <div className="document-image-list">
                {documentImages.map((image) => {
                  const added = draft.images.some(
                    (asset) =>
                      asset.source === 'feishu' &&
                      asset.docToken === image.ref.docRef.docToken &&
                      asset.blockId === image.id,
                  );
                  return (
                    <button
                      className={`image-candidate${added ? ' added' : ''}`}
                      disabled={!canEdit || added}
                      key={image.id}
                      onClick={() => addDocumentImage(image)}
                    >
                      {added ? '✓ 已添加' : '+ 添加'} 图片 #{image.id} ·{' '}
                      {image.data.width}×{image.data.height}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          {imageMessage ? (
            <div className={`resource-feedback ${imageMessage.type}`} role="status">
              {imageMessage.text}
            </div>
          ) : null}

          <div className="asset-list" ref={assetListRef}>
            {draft.images.map((image) => (
              <div className="asset-row" key={image.id}>
                <span className={`source-badge ${image.source}`}>
                  {image.source === 'remote' ? 'URL' : image.source === 'embedded' ? '嵌入' : '飞书'}
                </span>
                <input
                  value={image.path}
                  aria-label="资源虚拟路径"
                  onChange={(event) => updateImagePath(image.id, event.target.value)}
                />
                <span
                  className="asset-origin"
                  title={
                    image.source === 'remote'
                      ? image.url
                      : image.source === 'embedded'
                        ? image.name
                        : `Block ${image.blockId}`
                  }
                >
                  {image.source === 'remote'
                    ? image.url
                    : image.source === 'embedded'
                      ? `${image.name} · ${formatBytes(image.size)}`
                      : `图片块 #${image.blockId}`}
                </span>
                <button className="text-button" onClick={() => insertImageCode(image)}>插入代码</button>
                <button className="text-button danger" onClick={() => removeImage(image.id)}>移除</button>
              </div>
            ))}
            {!draft.images.length ? <div className="muted empty-row">尚未添加图片资源</div> : null}
          </div>
        </div>
      </section>
    </main>
  );
};

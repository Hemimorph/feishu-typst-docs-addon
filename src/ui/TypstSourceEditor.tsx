import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  nordDarkStyle,
  nordInit,
} from '@uiw/codemirror-theme-nord';
import { basicSetup } from 'codemirror';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags, type Tag } from '@lezer/highlight';
import { typst_lezer, typstTags } from 'codemirror-lang-typst/lezer';

export interface TypstSourceEditorHandle {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(options?: FocusOptions): void;
  setSelectionRange(start: number, end: number): void;
}

interface TypstSourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  labelledBy: string;
}

const typstLanguage = typst_lezer().language;

const reuseNordTokenStyle = (source: Tag, target: Tag) => {
  const sourceStyle = nordDarkStyle.find(({ tag }) => {
    const configuredTags = Array.isArray(tag) ? tag : [tag as Tag];
    return configuredTags.includes(source);
  });
  if (!sourceStyle) return { tag: target };
  const { tag: _sourceTag, ...style } = sourceStyle;
  return { tag: target, ...style };
};

const typstNordTheme = nordInit({
  styles: [
    reuseNordTokenStyle(tags.string, typstTags.mathDelimiter),
    reuseNordTokenStyle(tags.keyword, typstTags.listMarker),
    reuseNordTokenStyle(tags.variableName, typstTags.interpolated),
  ],
});

const clampSelection = (offset: number, length: number) =>
  Math.min(Math.max(Number.isFinite(offset) ? offset : length, 0), length);

export const TypstSourceEditor = forwardRef<
  TypstSourceEditorHandle,
  TypstSourceEditorProps
>(({ value, onChange, labelledBy }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const onChangeRef = useRef(onChange);
  const syncingValueRef = useRef(false);
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    get selectionStart() {
      return viewRef.current?.state.selection.main.from ?? 0;
    },
    get selectionEnd() {
      return viewRef.current?.state.selection.main.to ?? 0;
    },
    focus(options) {
      const view = viewRef.current;
      if (!view) return;
      if (options?.preventScroll) view.contentDOM.focus({ preventScroll: true });
      else view.focus();
    },
    setSelectionRange(start, end) {
      const view = viewRef.current;
      if (!view) return;
      const length = view.state.doc.length;
      view.dispatch({
        selection: EditorSelection.range(
          clampSelection(start, length),
          clampSelection(end, length),
        ),
      });
    },
  }), []);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return undefined;

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          typstLanguage,
          typstNordTheme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-labelledby': labelledBy,
            autocapitalize: 'off',
            autocomplete: 'off',
            autocorrect: 'off',
            spellcheck: 'false',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncingValueRef.current) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      viewRef.current = undefined;
      view.destroy();
    };
  }, [labelledBy]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    syncingValueRef.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    } finally {
      syncingValueRef.current = false;
    }
  }, [value]);

  return <div className="source-editor" ref={containerRef} />;
});

TypstSourceEditor.displayName = 'TypstSourceEditor';

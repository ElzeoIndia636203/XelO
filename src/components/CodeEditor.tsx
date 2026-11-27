import { useEffect, useRef } from 'react';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { SupportedLang } from '../lib/logic/starters';

function languageExtension(lang: SupportedLang) {
  switch (lang) {
    case 'cpp':
    case 'c':
      return cpp();
    case 'java':
      return java();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'go':
      return go();
  }
}

const xeioDarkTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#282C34',
      color: '#ABB2BF',
      height: '100%',
      fontSize: '13px',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      lineHeight: '1.6',
    },
    '.cm-gutters': {
      backgroundColor: '#282C34',
      color: '#5C6370',
      border: 'none',
      paddingRight: '8px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#2C313C',
      color: '#ABB2BF',
    },
    '.cm-activeLine': {
      backgroundColor: '#2C313C',
    },
    '&.cm-focused': {
      outline: '2px solid #3FA9F5',
      outlineOffset: '-2px',
    },
    '.cm-cursor': {
      borderLeftColor: '#FFFFFF',
    },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: '#3E4451',
    },
  },
  { dark: true },
);

const xeioHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#61AFEF' },
  { tag: tags.controlKeyword, color: '#C678DD' },
  { tag: [tags.meta, tags.processingInstruction, tags.special(tags.string)], color: '#7F848E' },
  { tag: tags.comment, color: '#7F848E', fontStyle: 'italic' },
  { tag: [tags.string, tags.character], color: '#98C379' },
  { tag: [tags.number, tags.integer, tags.float], color: '#D19A66' },
  { tag: [tags.bool, tags.null], color: '#D19A66' },
  { tag: [tags.typeName, tags.standard(tags.typeName)], color: '#56B6C2' },
  { tag: tags.function(tags.variableName), color: '#E5C07B' },
  { tag: tags.variableName, color: '#ABB2BF' },
  { tag: [tags.brace, tags.paren], color: '#E5C07B' },
  { tag: tags.squareBracket, color: '#61AFEF' },
  { tag: [tags.operator, tags.punctuation], color: '#ABB2BF' },
]);

export function CodeEditor({
  lang,
  value,
  readOnly = false,
  onChange,
}: {
  lang: SupportedLang;
  value: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const readOnlyComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const tabArmedRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const escapeTabKeymap = keymap.of([
      {
        key: 'Escape',
        run: () => {
          tabArmedRef.current = true;
          return true;
        },
      },
      {
        key: 'Tab',
        run: (view) => {
          if (tabArmedRef.current) {
            tabArmedRef.current = false;
            return false;
          }
          return indentWithTab.run ? indentWithTab.run(view) : false;
        },
        shift: (view) => {
          if (tabArmedRef.current) {
            tabArmedRef.current = false;
            return false;
          }
          return indentWithTab.shift ? indentWithTab.shift(view) : false;
        },
      },
    ]);

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        indentOnInput(),
        xeioDarkTheme,
        syntaxHighlighting(xeioHighlight),
        langComp.current.of(languageExtension(lang)),
        readOnlyComp.current.of(EditorState.readOnly.of(readOnly)),
        escapeTabKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({ 'aria-label': 'Code editor' }),
        EditorView.domEventHandlers({
          keydown: (ev) => {
            if (ev.key !== 'Escape') {
              tabArmedRef.current = false;
            }
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Create view once on mount; incremental prop sync below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langComp.current.reconfigure(languageExtension(lang)),
    });
  }, [lang]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyComp.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return (
    <div
      ref={hostRef}
      data-testid="codemirror-editor"
      style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: '#1B1B1A' }}
    />
  );
}

export default CodeEditor;

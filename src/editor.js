import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

const buffer = document.getElementById("editor-buffer");
const parent = document.getElementById("editor-view");

const editorDefaults = {
  lineWrapping: true,
  lineNumbers: false,
};

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "14px",
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "14px",
    lineHeight: "1.45",
    overflow: "auto",
  },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "14px",
    lineHeight: "1.45",
  },
});

const extensions = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  markdown({ base: markdownLanguage }),
  theme,
  EditorView.updateListener.of((update) => {
    if (update.docChanged && buffer) {
      buffer.value = update.state.doc.toString();
    }
  }),
];

if (editorDefaults.lineWrapping) {
  extensions.push(EditorView.lineWrapping);
}

const view = new EditorView({
  doc: buffer ? buffer.value : "",
  parent,
  extensions,
});

function setDoc(text) {
  const next = text ?? "";
  if (view.state.doc.toString() === next) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
  });
}

window.lightmdEditor = { view, setDoc, lineNumbers: editorDefaults.lineNumbers };

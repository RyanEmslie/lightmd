import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { parseFrontmatter } from "./frontmatter.js";

const buffer = document.getElementById("editor-buffer");
const parent = document.getElementById("editor-view");
const frontmatterEl = document.getElementById("frontmatter");
const previewBody = document.getElementById("preview-body");
const preview = document.getElementById("preview");

// Default on; Settings can toggle later.
const showFrontmatterBlock = true;

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
    if (update.docChanged) {
      const text = update.state.doc.toString();
      if (buffer) buffer.value = text;
      applyFrontmatter(text);
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

function setPreview(body) {
  const target = previewBody || preview;
  if (target) target.textContent = body;
}

function applyFrontmatter(text) {
  const parsed = parseFrontmatter(text);
  const show = showFrontmatterBlock && parsed.hasFrontmatter;
  if (frontmatterEl) {
    frontmatterEl.replaceChildren();
    if (show) {
      for (const [key, value] of Object.entries(parsed.frontmatter)) {
        const row = document.createElement("div");
        const k = document.createElement("span");
        k.className = "fm-key";
        k.textContent = key;
        const v = document.createElement("span");
        v.className = "fm-val";
        v.textContent = String(value ?? "");
        row.append(k, v);
        frontmatterEl.append(row);
      }
      frontmatterEl.hidden = false;
    } else {
      frontmatterEl.hidden = true;
    }
  }
  setPreview(parsed.body);
}

function setDoc(text) {
  const next = text ?? "";
  if (view.state.doc.toString() !== next) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
    });
  }
  applyFrontmatter(next);
}

applyFrontmatter(view.state.doc.toString());

window.lightmdEditor = { view, setDoc, lineNumbers: editorDefaults.lineNumbers };

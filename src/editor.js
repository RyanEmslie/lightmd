import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { parseFrontmatter } from "./frontmatter.js";
import { cancelAutosave, scheduleAutoSave } from "./autosave.js";
import { findExtension, runFind } from "./find.js";
import { preview as previewConfig, renderPreview, rewritePreviewImages } from "./preview.js";

const buffer = document.getElementById("editor-buffer");
const parent = document.getElementById("editor-view");
const frontmatterEl = document.getElementById("frontmatter");
const previewBody = document.getElementById("preview-body");
const previewPane = document.getElementById("preview");
let applyingLoad = false;

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
  ".cm-searchMatch": {
    backgroundColor: "#ffff0054",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "#ff6a0054",
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
      applyFrontmatter(text, previewConfig.live);
      if (!applyingLoad) {
        if (typeof window.lightmdSetDirty === "function") {
          window.lightmdSetDirty(true);
        }
        scheduleAutoSave();
      }
    }
  }),
];

if (editorDefaults.lineWrapping) {
  extensions.push(EditorView.lineWrapping);
}

extensions.push(findExtension);

const view = new EditorView({
  doc: buffer ? buffer.value : "",
  parent,
  extensions,
});

function setPreview(markdownBody) {
  const target = previewBody || previewPane;
  if (!target) return;
  target.replaceChildren();
  target.insertAdjacentHTML("afterbegin", renderPreview(markdownBody));
  const ws = window.lightmdWorkspace;
  void rewritePreviewImages(target, ws && ws.path, ws && ws.relative);
}

function applyFrontmatter(text, updatePreview = true) {
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
  if (updatePreview) setPreview(parsed.body);
}

function setDoc(text) {
  const next = text ?? "";
  cancelAutosave();
  applyingLoad = true;
  try {
    if (view.state.doc.toString() !== next) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    }
    applyFrontmatter(next);
  } finally {
    applyingLoad = false;
  }
}

applyFrontmatter(view.state.doc.toString());

const findButton = document.getElementById("find");
const findQuery = document.getElementById("find-query");

function applyFind() {
  const needle = findQuery ? findQuery.value : "";
  if (!needle && findQuery) findQuery.focus();
  runFind(view, needle);
}

const saveButton = document.getElementById("save");
if (saveButton) {
  saveButton.addEventListener("click", () => {
    applyFrontmatter(view.state.doc.toString(), true);
  });
}

if (findButton) findButton.addEventListener("click", applyFind);
if (findQuery) {
  findQuery.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyFind();
    }
  });
}

window.lightmdEditor = { view, setDoc, lineNumbers: editorDefaults.lineNumbers };
window.lightmdScheduleAutoSave = scheduleAutoSave;
window.lightmdCancelAutosave = cancelAutosave;

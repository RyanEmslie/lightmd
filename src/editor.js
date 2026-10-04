import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { parseFrontmatter } from "./frontmatter.js";
import { cancelAutosave, scheduleAutoSave } from "./autosave.js";
import {
  findExtension,
  findOptions,
  openWorkspaceHit,
  runFind,
  searchWorkspace,
} from "./find.js";
import { preview as previewConfig, renderPreview, rewritePreviewImages, bindPreviewLinks } from "./preview.js";
import { isHtmlFile, showHtmlViewer, hideHtmlViewer } from "./html-viewer.js";
import { applyTheme, setTheme } from "./palettes.js";
import { restoreLayout } from "./layout.js";
import { persistSession, restoreSession } from "./session.js";
import { editorDefaults, mountSettings } from "./settings.js";
import { bindKeyboard } from "./keyboard.js";

export { editorDefaults };

const buffer = document.getElementById("editor-buffer");
const parent = document.getElementById("editor-view");
const frontmatterEl = document.getElementById("frontmatter");
const previewBody = document.getElementById("preview-body");
const previewPane = document.getElementById("preview");
const wordCountEl = document.getElementById("word-count");
let applyingLoad = false;

function updateWordCount(text) {
  if (!wordCountEl) return;
  const trimmed = (text ?? "").trim();
  const n = trimmed ? trimmed.split(/\s+/).length : 0;
  wordCountEl.textContent = `${n} words`;
}

const wrapCompartment = new Compartment();
const lineNumberCompartment = new Compartment();
const activeLineCompartment = new Compartment();
const tabCompartment = new Compartment();
const fontCompartment = new Compartment();
const editableCompartment = new Compartment();

function editorFontTheme() {
  const size = `${editorDefaults.fontSize}px`;
  const lh = String(editorDefaults.lineHeight);
  return EditorView.theme({
    "&": { fontSize: size },
    ".cm-scroller": { fontSize: size, lineHeight: lh },
    ".cm-content": { fontSize: size, lineHeight: lh },
  });
}

function wrapExt() {
  return editorDefaults.lineWrapping ? EditorView.lineWrapping : [];
}

function lineNumberExt() {
  return editorDefaults.lineNumbers ? lineNumbers() : [];
}

function activeLineExt() {
  return editorDefaults.highlightActiveLine ? highlightActiveLine() : [];
}

function tabExt() {
  const size = Number(editorDefaults.tabSize) || 4;
  const unit = editorDefaults.softTabs ? " ".repeat(Math.max(1, size)) : "\t";
  return [EditorState.tabSize.of(size), indentUnit.of(unit)];
}

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "14px",
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
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
  ".cm-selectionBackground": {
    backgroundColor: "var(--accent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--accent)",
  },
  ".cm-searchMatch": {
    backgroundColor: "#ffff0054",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "#ff6a0054",
  },
});

applyTheme();

const extensions = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
  markdown({ base: markdownLanguage }),
  theme,
  fontCompartment.of(editorFontTheme()),
  wrapCompartment.of(wrapExt()),
  lineNumberCompartment.of(lineNumberExt()),
  activeLineCompartment.of(activeLineExt()),
  tabCompartment.of(tabExt()),
  editableCompartment.of(EditorView.editable.of(false)),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const text = update.state.doc.toString();
      if (buffer) buffer.value = text;
      applyFrontmatter(text, previewConfig.live);
      updateWordCount(text);
      if (!applyingLoad) {
        if (typeof window.lightmdSetDirty === "function") {
          window.lightmdSetDirty(true);
        }
        scheduleAutoSave();
      }
    }
  }),
];

extensions.push(findExtension);

const view = new EditorView({
  doc: buffer ? buffer.value : "",
  parent,
  extensions,
});

function currentRelative() {
  const ws = window.lightmdWorkspace;
  return ws && ws.relative;
}

function setPreview(content) {
  if (isHtmlFile(currentRelative())) {
    showHtmlViewer(content);
    return;
  }
  hideHtmlViewer();
  const target = previewBody || previewPane;
  if (!target) return;
  target.replaceChildren();
  target.insertAdjacentHTML("afterbegin", renderPreview(content));
  const ws = window.lightmdWorkspace;
  void rewritePreviewImages(target, ws && ws.path, ws && ws.relative);
}

function applyFrontmatter(text, updatePreview = true) {
  if (isHtmlFile(currentRelative())) {
    if (frontmatterEl) {
      frontmatterEl.replaceChildren();
      frontmatterEl.hidden = true;
    }
    if (updatePreview) setPreview(text);
    return;
  }
  const parsed = parseFrontmatter(text);
  const show = editorDefaults.frontmatter && parsed.hasFrontmatter;
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

// Every document (each open tab) gets its own EditorState, so loading a file
// is never an undoable edit and undo can't reach into another file's history.
// Background states keep their undo history, selection and scroll position.
let editableOn = false;
let activeDocKey = null;
const docStates = new WeakMap(); // key (e.g. a tab object) -> { state, scroll }

// Settings may have changed while a state was in the background.
function withCurrentSettings(state) {
  return state.update({
    effects: [
      fontCompartment.reconfigure(editorFontTheme()),
      wrapCompartment.reconfigure(wrapExt()),
      lineNumberCompartment.reconfigure(lineNumberExt()),
      activeLineCompartment.reconfigure(activeLineExt()),
      tabCompartment.reconfigure(tabExt()),
      editableCompartment.reconfigure(EditorView.editable.of(editableOn)),
    ],
  }).state;
}

function freshState(text) {
  return withCurrentSettings(EditorState.create({ doc: text, extensions }));
}

function stashActiveDoc() {
  if (activeDocKey) {
    docStates.set(activeDocKey, { state: view.state, scroll: view.scrollSnapshot() });
  }
}

// setState() runs no update listeners, so render the swapped-in text here.
function showState(state, scroll) {
  cancelAutosave();
  view.setState(state);
  if (scroll) view.dispatch({ effects: scroll });
  const text = state.doc.toString();
  if (buffer) buffer.value = text;
  applyFrontmatter(text);
  updateWordCount(text);
}

// Shows `text` as a new document with no undo history.
function setDoc(text) {
  stashActiveDoc();
  activeDocKey = null;
  showState(freshState(text ?? ""));
}

// Shows `key`'s own document. Its stashed state comes back when it still holds
// `text`; otherwise (first show, or reloaded from disk) it starts fresh.
function showDocument(key, text) {
  if (key == null) {
    setDoc(text);
    return;
  }
  const next = String(text ?? "");
  stashActiveDoc();
  const kept = docStates.get(key);
  activeDocKey = key;
  if (kept && kept.state.doc.toString() === next.replace(/\r\n?/g, "\n")) {
    showState(withCurrentSettings(kept.state), kept.scroll);
  } else {
    docStates.delete(key);
    showState(freshState(next));
  }
}

applyFrontmatter(view.state.doc.toString());
updateWordCount(view.state.doc.toString());
if (previewBody) bindPreviewLinks(previewBody);

function applyFind() {
  openSearchPanel(view);
}

const writeSave = window.lightmdSave;
window.lightmdSave = async () => {
  applyFrontmatter(view.state.doc.toString(), true);
  if (typeof writeSave === "function") await writeSave();
};
window.lightmdFind = () => {
  applyFind();
  return true;
};

const workspaceQuery = document.getElementById("find-workspace-query");
const workspaceRun = document.getElementById("find-workspace-run");
const workspaceStatus = document.getElementById("find-workspace-status");
const workspaceResults = document.getElementById("find-workspace-results");
const WORKSPACE_FILE_CAP = 1024 * 1024;
let workspaceSearchGen = 0;

function yieldToUi() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function renderWorkspaceHits(hits) {
  if (!workspaceResults) return;
  workspaceResults.replaceChildren();
  for (const hit of hits) {
    const item = document.createElement("li");
    item.dataset.relative = hit.relative;
    item.dataset.from = String(hit.from);
    item.dataset.to = String(hit.to);
    if (typeof hit.line === "number") item.dataset.line = String(hit.line);
    const path = document.createElement("div");
    path.className = "find-workspace-path";
    path.textContent = hit.relative;
    const preview = document.createElement("div");
    preview.className = "find-workspace-preview";
    preview.textContent = hit.preview || "";
    item.append(path, preview);
    workspaceResults.appendChild(item);
  }
}

async function runWorkspaceFind() {
  const gen = ++workspaceSearchGen;
  const needle = workspaceQuery ? workspaceQuery.value : "";
  if (workspaceStatus) workspaceStatus.textContent = "Searching…";
  if (workspaceResults) workspaceResults.replaceChildren();
  if (!needle) {
    if (workspaceStatus) workspaceStatus.textContent = "0 results";
    return;
  }
  const ws = window.lightmdWorkspace;
  const root = ws && ws.path;
  if (!root) {
    if (workspaceStatus) workspaceStatus.textContent = "0 results";
    return;
  }
  const invoke = window.__TAURI__?.core?.invoke;
  const hits = await searchWorkspace({
    root,
    needle,
    options: findOptions,
    invoke,
    fileCap: WORKSPACE_FILE_CAP,
    yieldToUi,
    shouldAbort: () => gen !== workspaceSearchGen,
  });
  if (gen !== workspaceSearchGen) return;
  renderWorkspaceHits(hits);
  if (workspaceStatus) workspaceStatus.textContent = `${hits.length} results`;
}

if (workspaceRun) workspaceRun.addEventListener("click", () => {
  void runWorkspaceFind();
});
if (workspaceQuery) {
  workspaceQuery.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runWorkspaceFind();
    }
  });
}
if (workspaceResults) {
  workspaceResults.addEventListener("click", async (event) => {
    const item = event.target.closest("li");
    if (!item || !workspaceResults.contains(item)) return;
    const from = Number(item.dataset.from);
    const to = Number(item.dataset.to);
    const line = Number(item.dataset.line);
    const hit = {
      relative: item.dataset.relative,
      from: Number.isFinite(from) ? from : undefined,
      to: Number.isFinite(to) ? to : undefined,
      line: Number.isFinite(line) ? line : undefined,
    };
    await openWorkspaceHit(hit, {
      applyFile: window.lightmdOpenFile,
      view,
      runFind,
      needle: workspaceQuery ? workspaceQuery.value : "",
    });
    if (typeof window.lightmdPersistSession === "function" && hit.relative) {
      window.lightmdPersistSession({ lastFile: hit.relative, file: hit.relative });
    }
  });
}

const themeSelect = document.getElementById("settings-theme");
if (themeSelect) {
  themeSelect.addEventListener("change", (event) => {
    setTheme(event.target.value);
    persistSession({ theme: event.target.value });
  });
}

function setLineWrapping(on) {
  editorDefaults.lineWrapping = !!on;
  view.dispatch({ effects: wrapCompartment.reconfigure(wrapExt()) });
}

function setLineNumbers(on) {
  editorDefaults.lineNumbers = !!on;
  view.dispatch({ effects: lineNumberCompartment.reconfigure(lineNumberExt()) });
}

function setHighlightActiveLine(on) {
  editorDefaults.highlightActiveLine = !!on;
  view.dispatch({ effects: activeLineCompartment.reconfigure(activeLineExt()) });
}

function setTabSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return;
  editorDefaults.tabSize = n;
  view.dispatch({ effects: tabCompartment.reconfigure(tabExt()) });
}

function setSoftTabs(on) {
  editorDefaults.softTabs = !!on;
  view.dispatch({ effects: tabCompartment.reconfigure(tabExt()) });
}

function setEditorFont(size, lineHeight) {
  const nextSize = Number(size);
  const nextLh = Number(lineHeight);
  if (Number.isFinite(nextSize) && nextSize > 0) editorDefaults.fontSize = nextSize;
  if (Number.isFinite(nextLh) && nextLh > 0) editorDefaults.lineHeight = nextLh;
  view.dispatch({ effects: fontCompartment.reconfigure(editorFontTheme()) });
  if (parent && parent.style) {
    parent.style.fontSize = `${editorDefaults.fontSize}px`;
    parent.style.lineHeight = String(editorDefaults.lineHeight);
  }
}

function setShowFrontmatter(on) {
  editorDefaults.frontmatter = !!on;
  applyFrontmatter(view.state.doc.toString(), previewConfig.live);
}

function setEditable(on) {
  editableOn = !!on;
  view.dispatch({
    effects: editableCompartment.reconfigure(EditorView.editable.of(!!on)),
  });
}

window.lightmdEditor = {
  view,
  setDoc,
  showDocument,
  setEditable,
  lineNumbers: editorDefaults.lineNumbers,
  setLineWrapping,
  setLineNumbers,
  setHighlightActiveLine,
  setTabSize,
  setSoftTabs,
  setEditorFont,
  setShowFrontmatter,
};
window.lightmdScheduleAutoSave = scheduleAutoSave;
window.lightmdCancelAutosave = cancelAutosave;
restoreLayout();
restoreSession();
mountSettings();
try {
  bindKeyboard();
} catch {
  // DOM-optional
}

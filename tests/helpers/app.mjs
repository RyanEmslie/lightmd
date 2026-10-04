// bootApp(): run the inline app glue from src/index.html in Node against the
// fake DOM (parsed from the real markup) and the fake Tauri backend.
//
//   const rt = bootApp({ files: { "a.md": "# A" } });
//   try {
//     await rt.win.lightmdOpenFolder(rt.folderPath);
//     await rt.win.lightmdOpenFile("a.md");
//     rt.el("editor-tabs").querySelector('[role="tab"]').click();
//     rt.files.get("a.md"); rt.writes; rt.invokes; rt.confirms;
//     await rt.requestClose();  // the window's close button; true if it closed
//   } finally {
//     rt.cleanup();
//   }
//
// editor.bundle.js does not run here: window.lightmdEditor is a stub that
// writes #editor-buffer, and autosave is a counting stub unless you pass
// realAutosave: true. The autosave settings (window.lightmdAutosave) and the
// "save failed" UI (lightmdShowSaveError/lightmdClearSaveError) are always the
// real ones from src/autosave.js, wired the way editor.js wires them. Drive
// CodeMirror, layout and the bundle in the e2e suite (tests/e2e) instead.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { clickAndAwait, createDocument, createWindow, memoryStorage } from "./dom.mjs";
import { inlineScripts, loadHtml, srcDir } from "./source.mjs";
import { buildTauriGlobals, createInvoke, normalizeRel } from "./tauri.mjs";

const autosaveModule = await import(pathToFileURL(join(srcDir, "autosave.js")).href);

/**
 * options:
 *   folderPath     the workspace folder the Open Folder dialog returns
 *                  (default "/tmp/lightmd-ws"); `files`/`folders` live under it
 *   files, folders, workspaces, capabilities, onInvoke
 *                  passed to createInvoke() (tests/helpers/tauri.mjs)
 *   dialog         { open, save, confirm } answers; save defaults to
 *                  `${folderPath}/fresh.md`, confirm to `confirmResult`
 *   confirmResult  legacy alias for dialog.confirm (default false)
 *   promptResult   what window.prompt() returns (default null)
 *   storage        localStorage (default: a fresh in-memory one)
 *   editor         methods merged over the window.lightmdEditor stub
 *   realAutosave   wire src/autosave.js instead of counting stubs
 *   html           markup to boot (default src/index.html)
 */
export function bootApp(options = {}) {
  const folderPath = options.folderPath || "/tmp/lightmd-ws";
  const storage = options.storage || memoryStorage();
  const dialog = {
    open: folderPath,
    save: `${folderPath}/fresh.md`,
    confirm: options.confirmResult ?? false,
    ...(options.dialog || {}),
  };
  const backend = createInvoke({
    root: folderPath,
    files: options.files,
    folders: options.folders,
    workspaces: options.workspaces,
    dialog,
    onInvoke: options.onInvoke,
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
  });

  const prev = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    __TAURI__: globalThis.__TAURI__,
    __TAURI_INTERNALS__: globalThis.__TAURI_INTERNALS__,
    confirm: globalThis.confirm,
    prompt: globalThis.prompt,
  };

  const html = options.html ?? loadHtml();
  const doc = createDocument(html);
  const win = createWindow(doc, { storage });
  const el = (id) => doc.getElementById(String(id));

  const prompts = [];
  let promptResult = options.promptResult ?? null;
  function confirmLike(message) {
    backend.confirms.push(String(message ?? ""));
    const said = backend.dialog.confirm;
    return typeof said === "function" ? !!said(message) : !!said;
  }
  win.confirm = confirmLike;
  win.prompt = function (message, def) {
    prompts.push({ message: String(message ?? ""), def });
    return promptResult;
  };
  const globals = buildTauriGlobals(backend.invoke);
  win.__TAURI__ = globals.__TAURI__;
  win.__TAURI_INTERNALS__ = globals.__TAURI_INTERNALS__;

  const state = { cancelCalls: 0, scheduleCalls: 0, setDocCalls: [] };
  Object.defineProperties(state, {
    confirmResult: {
      get: () => backend.dialog.confirm,
      set: (value) => {
        backend.dialog.confirm = value;
      },
    },
    promptResult: {
      get: () => promptResult,
      set: (value) => {
        promptResult = value;
      },
    },
  });

  const realAutosave = !!options.realAutosave;
  if (realAutosave) autosaveModule.cancelAutosave();
  win.lightmdCancelAutosave = function () {
    state.cancelCalls += 1;
    if (realAutosave) autosaveModule.cancelAutosave();
  };
  win.lightmdScheduleAutoSave = function () {
    state.scheduleCalls += 1;
    if (realAutosave) autosaveModule.scheduleAutoSave();
  };
  win.lightmdAutosave = autosaveModule.autosave;
  if (typeof autosaveModule.showSaveError === "function") {
    win.lightmdShowSaveError = autosaveModule.showSaveError;
  }
  if (typeof autosaveModule.clearSaveError === "function") {
    win.lightmdClearSaveError = autosaveModule.clearSaveError;
  }
  win.lightmdEditor = {
    editable: false,
    setDoc(text) {
      const v = text ?? "";
      state.setDocCalls.push(v);
      el("editor-buffer").value = v;
    },
    setEditable(on) {
      win.lightmdEditor.editable = !!on;
    },
    ...(options.editor || {}),
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = storage;
  globalThis.__TAURI__ = win.__TAURI__;
  globalThis.__TAURI_INTERNALS__ = win.__TAURI_INTERNALS__;
  globalThis.confirm = confirmLike;
  globalThis.prompt = win.prompt;

  const scripts = inlineScripts(html);
  assert.ok(scripts.length > 0, "src/index.html must contain an inline script");
  for (const script of scripts) {
    const run = new Function(script);
    run();
  }

  function restore(key) {
    if (prev[key] === undefined) delete globalThis[key];
    else globalThis[key] = prev[key];
  }

  function cleanup() {
    if (realAutosave) autosaveModule.cancelAutosave();
    for (const key of Object.keys(prev)) restore(key);
  }

  // The window's close button. Runs the app's close-requested listeners like
  // Tauri does and resolves to true when the window closed: it was destroyed,
  // or nothing was listening so Tauri closed it directly.
  async function requestClose() {
    const listening = backend.listeners.filter((l) => l.event === "tauri://close-requested");
    if (!listening.length) return true;
    const destroys = () => backend.windowCalls.filter((c) => c.cmd === "destroy").length;
    const before = destroys();
    for (const l of listening) {
      await win.__TAURI_INTERNALS__.runCallback(l.handler, {
        event: "tauri://close-requested",
        id: l.id,
        payload: null,
      });
    }
    return destroys() > before;
  }

  // Answer the in-app name dialog (New Folder) that askName() opened.
  async function answerNameDialog(value) {
    assert.equal(el("name-dialog").hidden, false, "precondition: the name dialog must be open");
    if (value == null) {
      await clickAndAwait(el("name-dialog-cancel"));
      return;
    }
    el("name-dialog-input").value = String(value);
    await clickAndAwait(el("name-dialog-ok"));
  }

  return {
    win,
    doc,
    el,
    storage,
    backend,
    invoke: backend.invoke,
    files: backend.files,
    get folders() {
      return backend.folders;
    },
    invokes: backend.invokes,
    writes: backend.writes,
    attemptedWrites: backend.attemptedWrites,
    confirms: backend.confirms,
    dialogs: backend.dialogs,
    prompts,
    state,
    folderPath,
    autosave: autosaveModule.autosave,
    cleanup,
    clickAndAwait,
    answerNameDialog,
    requestClose,
    normalizeRel,
  };
}

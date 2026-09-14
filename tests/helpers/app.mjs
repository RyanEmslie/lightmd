import assert from "node:assert/strict";
import { mockEl, memoryStorage, clickAndAwait } from "./dom.mjs";
import { inlineScripts, loadHtml } from "./source.mjs";
import { createInvoke, normalizeRel } from "./tauri.mjs";

const DEFAULT_TAGS = {
  "open-folder": "button",
  "new-note": "button",
  "new-folder": "button",
  save: "button",
  "save-as": "button",
  dirty: "span",
  "status-path": "span",
  "status-strip": "footer",
  "file-list": "ul",
  "editor-buffer": "textarea",
  "explorer-sort": "select",
  "show-extensions": "input",
  "preview-body": "div",
  preview: "section",
  "html-viewer": "iframe",
  "html-js": "input",
  "html-js-warn": "div",
  "html-js-chrome": "div",
  "find-workspace-query": "input",
  "find-workspace-run": "button",
  "find-workspace-status": "span",
  "find-workspace-results": "ul",
  "editor-tabs": "div",
  theme: "select",
  "settings-theme": "select",
};

export function bootApp(options = {}) {
  const files =
    options.files instanceof Map ? options.files : new Map(options.files || []);
  const folders = [...(options.folders || [])];
  const folderPath = options.folderPath || "/tmp/lightmd-ws";
  const tagById = { ...DEFAULT_TAGS, ...(options.tagById || {}) };
  const storage = options.storage || memoryStorage();
  const tauri = createInvoke({
    files,
    folders,
    modifiedOrder: options.modifiedOrder,
    onInvoke: options.onInvoke,
  });

  const prev = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    __TAURI__: globalThis.__TAURI__,
    confirm: globalThis.confirm,
    prompt: globalThis.prompt,
  };

  const byId = new Map();
  function el(id) {
    const key = String(id);
    if (!byId.has(key)) byId.set(key, mockEl(key, tagById[key] || "div"));
    return byId.get(key);
  }
  for (const id of Object.keys(tagById)) el(id);
  el("show-extensions").checked = true;
  el("explorer-sort").value = "name";
  el("dirty").hidden = true;
  el("editor-buffer").value = "";
  el("status-path").textContent = "";
  el("preview-body").textContent = "";
  el("html-viewer").hidden = true;
  el("html-js").checked = false;
  el("html-js-warn").hidden = true;

  const doc = {
    documentElement: mockEl("html", "html"),
    body: mockEl("body", "body"),
    getElementById(id) {
      return el(id);
    },
    querySelector(sel) {
      const m = String(sel || "").match(/^#([\w-]+)$/);
      return m ? el(m[1]) : doc.body.querySelector(sel);
    },
    querySelectorAll(sel) {
      return doc.body.querySelectorAll(sel);
    },
    createElement(tag) {
      return mockEl("", tag);
    },
    createElementNS(_ns, tag) {
      return mockEl("", tag);
    },
  };

  const confirms = [];
  const prompts = [];
  let confirmResult = options.confirmResult ?? false;
  let promptResult = options.promptResult ?? null;

  function confirmLike(message) {
    confirms.push(String(message ?? ""));
    return confirmResult;
  }

  const win = { document: doc };
  win.confirm = confirmLike;
  win.prompt = function (message, def) {
    prompts.push({ message: String(message ?? ""), def });
    return promptResult;
  };
  win.__TAURI__ = {
    core: { invoke: tauri.invoke },
    dialog: {
      async open() {
        return folderPath;
      },
      async save() {
        return `${folderPath}/fresh.md`;
      },
      async ask(message) {
        return confirmLike(message);
      },
      async confirm(message) {
        return confirmLike(message);
      },
    },
  };

  const state = {
    cancelCalls: 0,
    scheduleCalls: 0,
    setDocCalls: [],
  };
  Object.defineProperties(state, {
    confirmResult: {
      get() {
        return confirmResult;
      },
      set(value) {
        confirmResult = value;
      },
    },
    promptResult: {
      get() {
        return promptResult;
      },
      set(value) {
        promptResult = value;
      },
    },
  });

  win.lightmdCancelAutosave = function () {
    state.cancelCalls += 1;
  };
  win.lightmdScheduleAutoSave = function () {
    state.scheduleCalls += 1;
  };
  win.lightmdEditor = {
    setDoc(text) {
      const v = text ?? "";
      state.setDocCalls.push(v);
      el("editor-buffer").value = v;
    },
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = storage;
  globalThis.__TAURI__ = win.__TAURI__;
  globalThis.confirm = confirmLike;
  globalThis.prompt = win.prompt;

  const scripts = inlineScripts(loadHtml());
  assert.ok(scripts.length > 0, "src/index.html must contain an inline script");
  for (const script of scripts) {
    const run = new Function(script);
    run();
  }

  function cleanup() {
    globalThis.document = prev.document;
    globalThis.window = prev.window;
    globalThis.localStorage = prev.localStorage;
    if (prev.__TAURI__ === undefined) delete globalThis.__TAURI__;
    else globalThis.__TAURI__ = prev.__TAURI__;
    if (prev.confirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = prev.confirm;
    if (prev.prompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = prev.prompt;
  }

  return {
    win,
    doc,
    el,
    storage,
    files,
    folders: tauri.folders,
    invokes: tauri.invokes,
    writes: tauri.writes,
    attemptedWrites: tauri.attemptedWrites,
    confirms,
    prompts,
    state,
    folderPath,
    cleanup,
    clickAndAwait,
    normalizeRel,
  };
}

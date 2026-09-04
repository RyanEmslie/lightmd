import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const htmlPath = join(srcDir, "index.html");

const FOLDER_A = "/tmp/lightmd-folder-a";
const FOLDER_B = "/tmp/lightmd-folder-b";
const FILE_A = "note.md";
const BODY_A = "# Note A\n\nfrom folder A\n";
const DIRTY_A = "dirty buffer from A — must not land in B\n";
const SESSION_KEY = "lightmd.session";

installStubGlobals();

const { cancelAutosave, scheduleAutoSave } = await import(
  pathToFileURL(join(srcDir, "autosave.js")).href
);
const { persistSession, getSession } = await import(
  pathToFileURL(join(srcDir, "session.js")).href
);

function installStubGlobals() {
  if (!globalThis.document) {
    globalThis.document = {
      getElementById() {
        return null;
      },
      createElement() {
        return { style: {}, classList: { add() {}, remove() {} } };
      },
    };
  }
  if (!globalThis.window) globalThis.window = globalThis;
  if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== "function") {
    globalThis.localStorage = memoryStorage();
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      const k = String(key);
      return map.has(k) ? map.get(k) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function inlineScripts(html) {
  const out = [];
  const re = /<script\b(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function mockEl(id, tag = "div") {
  const listeners = {};
  const el = {
    id,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    value: tag === "select" ? "name" : "",
    checked: tag === "input" ? true : false,
    hidden: id === "dirty",
    disabled: false,
    textContent: "",
    innerHTML: "",
    className: "",
    children: [],
    parentNode: null,
    dataset: {},
    attributes: {},
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    addEventListener(type, fn) {
      (listeners[String(type)] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[String(type)];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(event) {
      const type = event?.type ?? event;
      const ev =
        event && typeof event === "object"
          ? event
          : { type, target: el, preventDefault() {}, stopPropagation() {} };
      if (ev.target == null) ev.target = el;
      ev.currentTarget = el;
      const results = [];
      for (const fn of listeners[String(type)] || []) {
        results.push(fn.call(el, ev));
      }
      el._lastDispatch = results;
      return true;
    },
    click() {
      return el.dispatchEvent({
        type: "click",
        bubbles: true,
        target: el,
        preventDefault() {},
        stopPropagation() {},
      });
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    append(...nodes) {
      for (const n of nodes) el.appendChild(n);
    },
    replaceChildren(...nodes) {
      for (const c of el.children) c.parentNode = null;
      el.children = [];
      for (const n of nodes) el.appendChild(n);
    },
    contains(node) {
      if (node === el) return true;
      for (const c of el.children) {
        if (c === node || (typeof c.contains === "function" && c.contains(node))) {
          return true;
        }
      }
      return false;
    },
    closest(sel) {
      const want = String(sel || "");
      let n = el;
      while (n) {
        if (want.startsWith("#") && n.id === want.slice(1)) return n;
        if (want.startsWith(".") && String(n.className || "").split(/\s+/).includes(want.slice(1))) {
          return n;
        }
        if (n.tagName === want.toUpperCase()) return n;
        n = n.parentNode;
      }
      return null;
    },
    setAttribute(name, value) {
      const key = String(name);
      el.attributes[key] = String(value);
      if (key === "id") el.id = String(value);
      if (key === "hidden") el.hidden = true;
      if (key.startsWith("data-")) {
        const dk = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[dk] = String(value);
      }
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name)
        ? el.attributes[name]
        : null;
    },
    removeAttribute(name) {
      delete el.attributes[name];
      if (name === "hidden") el.hidden = false;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

function installLocalStorage() {
  const ls = memoryStorage();
  globalThis.localStorage = ls;
  return ls;
}

async function clickAndAwait(el) {
  el.click();
  const results = el._lastDispatch || [];
  await Promise.all(
    results.filter((r) => r && typeof r.then === "function"),
  );
}

function parseStoredSession(ls) {
  const raw = ls.getItem(SESSION_KEY);
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function lastFileOf(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("lastFile" in value) return value.lastFile;
  if ("file" in value) return value.file;
  return undefined;
}

function isClearedFile(file) {
  return file == null || file === "" || file === false;
}

function isAsRelativeUnderNewFolder(file) {
  if (isClearedFile(file)) return false;
  const s = String(file).replace(/\\/g, "/");
  if (s === FILE_A) return true;
  if (s.endsWith(`/${FILE_A}`) && !s.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(s)) {
    return true;
  }
  const aRoot = FOLDER_A.replace(/\\/g, "/").replace(/\/+$/, "");
  const bRoot = FOLDER_B.replace(/\\/g, "/").replace(/\/+$/, "");
  if (s === `${aRoot}/${FILE_A}`) return true;
  if (s === `${bRoot}/${FILE_A}`) return true;
  return false;
}

function isWriteAIntoB(write) {
  if (!write) return false;
  const path = String(write.path ?? "").replace(/\\/g, "/");
  const relative = String(write.relative ?? "").replace(/\\/g, "/");
  const bRoot = FOLDER_B.replace(/\\/g, "/").replace(/\/+$/, "");
  const aRel = relative === FILE_A || relative.endsWith(`/${FILE_A}`);
  return path === bRoot && aRel;
}

function installFakeTimers() {
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  const pending = new Map();
  let nextId = 1;
  globalThis.setTimeout = function (fn, _ms, ...args) {
    const id = nextId++;
    pending.set(id, { fn, args });
    return id;
  };
  globalThis.clearTimeout = function (id) {
    pending.delete(id);
  };
  return {
    async flush() {
      const jobs = [...pending.values()];
      pending.clear();
      await Promise.all(
        jobs.map((job) => Promise.resolve().then(() => job.fn(...job.args))),
      );
    },
    restore() {
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
      pending.clear();
    },
  };
}

function boot() {
  cancelAutosave();
  const storage = installLocalStorage();
  persistSession({
    lastFolder: null,
    lastFile: null,
    folder: null,
    file: null,
  });

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLs = globalThis.localStorage;
  const prevTauri = globalThis.__TAURI__;

  const byId = new Map();
  const tagById = {
    "open-folder": "button",
    save: "button",
    dirty: "span",
    "status-path": "span",
    "file-list": "ul",
    "editor-buffer": "textarea",
    "explorer-sort": "select",
    "show-extensions": "input",
  };

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

  const writes = [];
  const invokes = [];
  const persistCalls = [];
  const state = { cancelCalls: 0, scheduleCalls: 0, setDocCalls: [] };

  const doc = {
    documentElement: mockEl("html"),
    body: mockEl("body"),
    getElementById(id) {
      return el(id);
    },
    querySelector(sel) {
      const m = String(sel || "").match(/^#([\w-]+)$/);
      return m ? el(m[1]) : null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return mockEl("", tag);
    },
  };

  const win = {
    document: doc,
  };

  win.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        invokes.push({ cmd, args });
        if (cmd === "list_workspace") {
          const path = String(args.path || "");
          if (path === FOLDER_B) {
            return [{ relative_path: "other.md", is_dir: false }];
          }
          return [{ relative_path: FILE_A, is_dir: false }];
        }
        if (cmd === "read_workspace_file") {
          return BODY_A;
        }
        if (cmd === "write_workspace_file") {
          writes.push({
            path: args.path,
            relative: args.relative,
            contents: args.contents,
          });
          return;
        }
        return null;
      },
    },
    dialog: {
      async open() {
        return FOLDER_B;
      },
    },
  };

  win.lightmdCancelAutosave = function () {
    state.cancelCalls += 1;
    cancelAutosave();
  };
  win.lightmdScheduleAutoSave = function () {
    state.scheduleCalls += 1;
    scheduleAutoSave();
  };
  win.lightmdPersistSession = function (partial, fileArg) {
    persistCalls.push({
      partial,
      fileArg,
      argc: arguments.length,
    });
    return persistSession(partial, fileArg);
  };
  win.lightmdEditor = {
    setDoc(text) {
      state.setDocCalls.push(text);
      el("editor-buffer").value = text ?? "";
    },
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = storage;
  globalThis.__TAURI__ = win.__TAURI__;

  const scripts = inlineScripts(loadHtml());
  assert.ok(scripts.length > 0, "src/index.html must contain an inline script with applyFolder");
  for (const script of scripts) {
    const run = new Function(script);
    run();
  }

  assert.equal(
    typeof win.lightmdOpenFolder,
    "function",
    "missing applyFolder (window.lightmdOpenFolder)",
  );
  assert.equal(
    typeof win.lightmdOpenFile,
    "function",
    "missing applyFile (window.lightmdOpenFile)",
  );

  function cleanup() {
    cancelAutosave();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.localStorage = prevLs;
    if (prevTauri === undefined) delete globalThis.__TAURI__;
    else globalThis.__TAURI__ = prevTauri;
  }

  return {
    win,
    doc,
    el,
    writes,
    invokes,
    persistCalls,
    state,
    storage,
    cleanup,
  };
}

async function openFolderAWithFile(rt) {
  await rt.win.lightmdOpenFolder(FOLDER_A);
  await rt.win.lightmdOpenFile(FILE_A);
  persistSession({
    lastFolder: FOLDER_A,
    lastFile: FILE_A,
    folder: FOLDER_A,
    file: FILE_A,
  });
  const ws = rt.win.lightmdWorkspace;
  assert.equal(
    ws && ws.relative,
    FILE_A,
    "precondition: open file in folder A must bind lightmdWorkspace.relative",
  );
  assert.equal(
    ws && ws.path,
    FOLDER_A,
    "precondition: open folder A must bind lightmdWorkspace.path",
  );
}

async function openFolderAFileAndScheduleAutosave(rt) {
  await openFolderAWithFile(rt);
  const buffer = rt.el("editor-buffer");
  buffer.value = DIRTY_A;
  buffer.dispatchEvent({ type: "input", target: buffer });
  if (rt.state.scheduleCalls === 0 && typeof rt.win.lightmdScheduleAutoSave === "function") {
    if (typeof rt.win.lightmdSetDirty === "function") rt.win.lightmdSetDirty(true);
    rt.win.lightmdScheduleAutoSave();
  }
  assert.equal(rt.el("dirty").hidden, false, "precondition: buffer must be dirty");
  assert.ok(
    rt.state.scheduleCalls > 0,
    "precondition: dirty edit must schedule autosave",
  );
}

test("applyFolder(B) cancels pending autosave so A's buffer is not written into B", async () => {
  const rt = boot();
  const timers = installFakeTimers();
  try {
    await openFolderAFileAndScheduleAutosave(rt);
    const writesBefore = rt.writes.length;
    const cancelsBefore = rt.state.cancelCalls;
    await rt.win.lightmdOpenFolder(FOLDER_B);
    await timers.flush();
    const newWrites = rt.writes.slice(writesBefore);
    const wroteAIntoB = newWrites.some(isWriteAIntoB);
    const cancelled = rt.state.cancelCalls > cancelsBefore;
    assert.equal(
      wroteAIntoB,
      false,
      "applyFolder(B) must cancel pending autosave / not write A's buffer into B (write_workspace_file with A's relative under B)",
    );
    assert.ok(
      cancelled || !wroteAIntoB,
      "applyFolder(B) must call cancelAutosave (or otherwise prevent a write of A's buffer into B)",
    );
  } finally {
    timers.restore();
    rt.cleanup();
  }
});

test("after applyFolder(B), relative is cleared, buffer is cleared or unbound, dirty is false", async () => {
  const rt = boot();
  try {
    await openFolderAFileAndScheduleAutosave(rt);
    await rt.win.lightmdOpenFolder(FOLDER_B);
    const ws = rt.win.lightmdWorkspace;
    const relative = ws ? ws.relative : FILE_A;
    const unbound =
      relative == null || relative === "" || relative === false;
    assert.ok(
      unbound,
      `lightmdWorkspace.relative must be cleared/null/empty after applyFolder(B), not A's path (got ${JSON.stringify(relative)})`,
    );
    assert.notEqual(
      String(relative ?? ""),
      FILE_A,
      "lightmdWorkspace.relative must not remain A's path after applyFolder(B)",
    );
    const bufferVal = rt.el("editor-buffer").value;
    const cleared =
      bufferVal == null ||
      bufferVal === "" ||
      rt.state.setDocCalls.some((t) => t == null || t === "");
    assert.ok(
      unbound || cleared,
      "buffer must be cleared or unbound after applyFolder(B)",
    );
    assert.equal(
      rt.el("dirty").hidden,
      true,
      "dirty must be false after applyFolder(B)",
    );
  } finally {
    rt.cleanup();
  }
});

test("Save after applyFolder(B) without opening a file does not write A's relative under B", async () => {
  const rt = boot();
  try {
    await openFolderAWithFile(rt);
    const buffer = rt.el("editor-buffer");
    buffer.value = DIRTY_A;
    buffer.dispatchEvent({ type: "input", target: buffer });
    await rt.win.lightmdOpenFolder(FOLDER_B);
    const writesBefore = rt.writes.length;
    await clickAndAwait(rt.el("save"));
    const newWrites = rt.writes.slice(writesBefore);
    assert.equal(
      newWrites.some(isWriteAIntoB),
      false,
      "Save after switch without opening a file in B must not invoke write_workspace_file with A's relative under B's path",
    );
  } finally {
    rt.cleanup();
  }
});

test("session lastFile is cleared on folder change until a file is opened in B", async () => {
  const rt = boot();
  try {
    await openFolderAWithFile(rt);
    const before = lastFileOf(getSession());
    assert.ok(
      isAsRelativeUnderNewFolder(before),
      "precondition: lastFile should be A's relative before switching folders",
    );
    await rt.win.lightmdOpenFolder(FOLDER_B);
    const sess = getSession();
    const stored = parseStoredSession(rt.storage);
    const live = lastFileOf(sess);
    const persisted = lastFileOf(stored);
    assert.equal(
      isAsRelativeUnderNewFolder(live),
      false,
      "session lastFile must be cleared/invalidated on folder change (not left as A's relative under the new folder)",
    );
    assert.equal(
      isAsRelativeUnderNewFolder(persisted),
      false,
      "persistSession lastFile must be cleared/invalidated on folder change (not left as A's relative under the new folder) until a file is opened in B",
    );
    assert.ok(
      isClearedFile(live) || !isAsRelativeUnderNewFolder(live),
      "lastFile must stay cleared until a file is opened in B",
    );
  } finally {
    rt.cleanup();
  }
});

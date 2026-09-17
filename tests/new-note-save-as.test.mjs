import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceText } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const htmlPath = join(srcDir, "index.html");

const FOLDER = "/tmp/lightmd-new-note-ws";
const FILE_A = "note.md";
const BODY_A = "# Note A\n\nfrom the open file\n";
const PRIOR_PREVIEW = "PRIOR_PREVIEW_UNIQUE_zxq9";
const NEW_BODY = "# Fresh note\n\ncreated via Save As\n";
const EXISTING_REL = "a.md";
const EXISTING_BODY = "already on disk — must not clobber silently\n";
const FRESH_REL = "fresh.md";
const PLAIN_NAME = "untitled-plain";
const ESCAPE_REL = "../outside.md";

const NEW_NOTE_IDS = ["new-note", "new_note", "newNote"];
const SAVE_AS_IDS = ["save-as", "save_as", "saveAs"];
const NEW_NOTE_FNS = [
  "lightmdNewNote",
  "newNote",
  "startNewNote",
  "createNewNote",
];
const SAVE_AS_FNS = ["lightmdSaveAs", "saveAs", "saveNoteAs"];
const NOTE_MODULES = ["new-note.js", "note.js", "notes.js", "save-as.js"];

installStubGlobals();

const { cancelAutosave, scheduleAutoSave } = await import(
  pathToFileURL(join(srcDir, "autosave.js")).href
);

const apiModules = await loadApiModules();

function installStubGlobals() {
  if (!globalThis.document) {
    globalThis.document = {
      getElementById() {
        return null;
      },
      createElement() {
        return { style: {}, classList: { add() {}, remove() {} }, dataset: {} };
      },
    };
  }
  if (!globalThis.window) globalThis.window = globalThis;
}

async function loadApiModules() {
  const apis = {};
  for (const name of NOTE_MODULES) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(`${pathToFileURL(p).href}?new-note-save-as=${Date.now()}`);
      Object.assign(apis, mod);
    } catch {
      // Optional until New Note / Save As exist.
    }
  }
  return apis;
}

function loadSources() {
  return loadSourceText();
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

function hasNewNoteControl(src) {
  if (/\bid=["']new[-_]?note["']/i.test(src)) return true;
  if (/\.id\s*=\s*["']new[-_]?note["']/i.test(src)) return true;
  if (/getElementById\(\s*["']new[-_]?note["']\s*\)/.test(src)) return true;
  if (
    /<button\b[^>]*>[\s\S]{0,80}?\bnew\s+note\b[\s\S]{0,80}?<\/button>/i.test(src)
  ) {
    return true;
  }
  if (
    /createElement\(\s*["']button["']\)[\s\S]{0,240}?(?:textContent|innerText|innerHTML|aria-label)\s*=\s*["'][^"']*\bnew\s+note\b/i.test(
      src,
    )
  ) {
    return true;
  }
  if (/aria-label=["'][^"']*\bnew\s+note\b[^"']*["']/i.test(src)) return true;
  if (/data-action=["']new[-_]?note["']/i.test(src)) return true;
  return false;
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

function mockEl(id, tag = "div") {
  const listeners = {};
  const el = {
    id,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    value: tag === "select" ? "name" : tag === "textarea" ? "" : "",
    checked: tag === "input",
    hidden: id === "dirty" || id === "html-viewer",
    disabled: false,
    textContent: "",
    innerHTML: "",
    title: "",
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
      if (typeof fn !== "function") return;
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
      el.innerHTML = "";
      el.textContent = "";
      for (const n of nodes) el.appendChild(n);
    },
    insertAdjacentHTML(position, html) {
      const chunk = String(html ?? "");
      if (String(position) === "afterbegin") {
        el.innerHTML = chunk + String(el.innerHTML || "");
      } else {
        el.innerHTML = String(el.innerHTML || "") + chunk;
      }
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
      if (key === "title") el.title = String(value);
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
      if (name === "title") el.title = "";
    },
    querySelector(sel) {
      const all = el.querySelectorAll(sel);
      return all[0] ?? null;
    },
    querySelectorAll(sel) {
      const want = String(sel || "");
      const out = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (want.startsWith("#") && c.id === want.slice(1)) out.push(c);
          else if (want.startsWith(".") && String(c.className || "").split(/\s+/).includes(want.slice(1))) {
            out.push(c);
          } else if (c.tagName === want.toUpperCase()) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
  };
  return el;
}

async function clickAndAwait(el) {
  el.click();
  const results = el._lastDispatch || [];
  await Promise.all(results.filter((r) => r && typeof r.then === "function"));
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

function normalizeRel(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function isUnbound(relative) {
  return relative == null || relative === "" || relative === false;
}

function isUntitledCue(text) {
  return /untitled|unsaved|new\s*note/i.test(String(text || ""));
}

function pathShows(text, relative) {
  const t = normalizeRel(text).trim();
  const r = normalizeRel(relative);
  if (!r) return false;
  return t === r || t.endsWith(r) || t.includes(r);
}

function isEscapingRelative(relative) {
  const n = normalizeRel(relative);
  if (!n) return false;
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return true;
  let depth = 0;
  for (const part of n.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}

function hasMdExtension(relative) {
  return /\.md$/i.test(normalizeRel(relative));
}

function previewText(el) {
  return `${el?.innerHTML ?? ""}\n${el?.textContent ?? ""}`;
}

function isEmptyPreview(el) {
  const html = String(el?.innerHTML ?? "").trim();
  const text = String(el?.textContent ?? "").trim();
  if (!html && !text) return true;
  if (/^preview$/i.test(text) && !/<h1|<p>[^<]/i.test(html)) return true;
  if (html === "<p></p>" || html === "<p><br></p>") return true;
  return false;
}

function pickFn(holder, names) {
  if (!holder || typeof holder !== "object") return null;
  for (const name of names) {
    if (typeof holder[name] === "function") return holder[name].bind(holder);
  }
  return null;
}

function resolveNewNote(rt) {
  return (
    pickFn(rt.win, NEW_NOTE_FNS) ||
    pickFn(globalThis, NEW_NOTE_FNS) ||
    pickFn(apiModules, NEW_NOTE_FNS) ||
    pickFn(rt.mod, NEW_NOTE_FNS)
  );
}

function resolveSaveAs(rt) {
  return (
    pickFn(rt.win, SAVE_AS_FNS) ||
    pickFn(globalThis, SAVE_AS_FNS) ||
    pickFn(apiModules, SAVE_AS_FNS) ||
    pickFn(rt.mod, SAVE_AS_FNS)
  );
}

function boot() {
  cancelAutosave();
  const storage = memoryStorage();

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLs = globalThis.localStorage;
  const prevTauri = globalThis.__TAURI__;
  const prevConfirm = globalThis.confirm;

  const byId = new Map();
  const tagById = {
    "open-folder": "button",
    save: "button",
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
  };

  function el(id) {
    const key = String(id);
    if (!byId.has(key)) byId.set(key, mockEl(key, tagById[key] || "div"));
    return byId.get(key);
  }

  for (const id of NEW_NOTE_IDS) tagById[id] = "button";
  for (const id of SAVE_AS_IDS) tagById[id] = "button";
  for (const id of Object.keys(tagById)) el(id);
  el("show-extensions").checked = true;
  el("explorer-sort").value = "name";
  el("dirty").hidden = true;
  el("editor-buffer").value = "";
  el("status-path").textContent = "";
  el("preview-body").textContent = "";
  el("html-viewer").hidden = true;

  const writes = [];
  const attemptedWrites = [];
  const invokes = [];
  const confirms = [];
  const state = {
    cancelCalls: 0,
    scheduleCalls: 0,
    setDocCalls: [],
    confirmResult: false,
  };
  const files = new Map([
    [FILE_A, BODY_A],
    [EXISTING_REL, EXISTING_BODY],
  ]);

  const doc = {
    documentElement: mockEl("html", "html"),
    body: mockEl("body", "body"),
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

  const win = { document: doc };

  function confirmLike(message) {
    confirms.push(String(message ?? ""));
    return state.confirmResult;
  }

  win.confirm = confirmLike;
  globalThis.confirm = confirmLike;

  win.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        invokes.push({ cmd, args });
        if (cmd === "list_workspace") {
          return [...files.keys()].map((relative_path) => ({
            relative_path,
            is_dir: false,
          }));
        }
        if (cmd === "read_workspace_file") {
          const rel = normalizeRel(args.relative);
          if (isEscapingRelative(rel) || !files.has(rel)) {
            throw new Error(`read_workspace_file: missing ${rel}`);
          }
          return files.get(rel);
        }
        if (
          cmd === "write_workspace_file" ||
          cmd === "write_file" ||
          cmd === "write"
        ) {
          const record = {
            cmd,
            path: args.path,
            relative: args.relative,
            contents: args.contents,
          };
          attemptedWrites.push(record);
          const rel = normalizeRel(args.relative);
          if (isEscapingRelative(rel)) {
            throw new Error("path is outside workspace root");
          }
          files.set(rel, String(args.contents ?? ""));
          writes.push(record);
          return;
        }
        if (
          cmd === "workspace_file_exists" ||
          cmd === "file_exists" ||
          cmd === "exists"
        ) {
          return files.has(normalizeRel(args.relative ?? args.path ?? ""));
        }
        return null;
      },
    },
    dialog: {
      async open() {
        return FOLDER;
      },
      async save() {
        return `${FOLDER}/${FRESH_REL}`;
      },
      async ask(message) {
        return confirmLike(message);
      },
      async confirm(message) {
        return confirmLike(message);
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
  win.lightmdEditor = {
    setDoc(text) {
      const v = text ?? "";
      state.setDocCalls.push(v);
      el("editor-buffer").value = v;
      const preview = el("preview-body");
      preview.replaceChildren();
      preview.innerHTML = v ? `<p>${v}</p>` : "";
      preview.textContent = v;
    },
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = storage;
  globalThis.__TAURI__ = win.__TAURI__;

  const scripts = inlineScripts(loadHtml());
  assert.ok(scripts.length > 0, "src/index.html must contain an inline script");
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
    if (prevConfirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = prevConfirm;
    if (prevTauri === undefined) delete globalThis.__TAURI__;
    else globalThis.__TAURI__ = prevTauri;
  }

  return {
    win,
    doc,
    el,
    writes,
    attemptedWrites,
    invokes,
    confirms,
    files,
    state,
    storage,
    mod: apiModules,
    cleanup,
  };
}

async function openFolderAndFile(rt) {
  await rt.win.lightmdOpenFolder(FOLDER);
  await rt.win.lightmdOpenFile(FILE_A);
  const ws = rt.win.lightmdWorkspace;
  assert.equal(
    ws && ws.relative,
    FILE_A,
    "precondition: open file must bind lightmdWorkspace.relative",
  );
  assert.equal(
    ws && ws.path,
    FOLDER,
    "precondition: open folder must bind lightmdWorkspace.path",
  );
  rt.el("preview-body").innerHTML = `<p>${PRIOR_PREVIEW}</p>`;
  rt.el("preview-body").textContent = PRIOR_PREVIEW;
  return ws;
}

async function invokeNewNote(rt) {
  const fn = resolveNewNote(rt);
  assert.ok(
    typeof fn === "function",
    "missing newNote() (window.lightmdNewNote / newNote / export newNote)",
  );
  await fn();
}

async function invokeSaveAs(rt, spec) {
  const fn = resolveSaveAs(rt);
  assert.ok(
    typeof fn === "function",
    "missing saveAs() (window.lightmdSaveAs / saveAs / export saveAs)",
  );
  const payload = {
    path: spec.path ?? spec.root ?? FOLDER,
    root: spec.root ?? spec.path ?? FOLDER,
    relative: spec.relative,
    filename: spec.filename ?? spec.relative,
  };
  if (spec.contents != null) payload.contents = spec.contents;
  return await fn(payload);
}

test("New Note control exists (button#new-note or equivalent)", () => {
  const src = `${loadHtml()}\n${loadSources()}`;
  assert.ok(
    hasNewNoteControl(src),
    "missing New Note control (button id new-note or equivalent)",
  );
});

test("newNote() clears buffer to empty md session, unbinds currentRelative, dirty clean, preview empty/safe, status-path cleared or untitled", async () => {
  const rt = boot();
  try {
    await openFolderAndFile(rt);
    const buffer = rt.el("editor-buffer");
    buffer.value = "dirty leftover that newNote must discard";
    buffer.dispatchEvent({ type: "input", target: buffer });
    if (typeof rt.win.lightmdSetDirty === "function") rt.win.lightmdSetDirty(true);

    await invokeNewNote(rt);

    const ws = rt.win.lightmdWorkspace;
    const relative = ws ? ws.relative : FILE_A;
    assert.ok(
      isUnbound(relative),
      `currentRelative must be cleared/unbound after newNote(), not bound to the prior file (got ${JSON.stringify(relative)})`,
    );
    assert.notEqual(
      normalizeRel(relative),
      FILE_A,
      "newNote() must not leave currentRelative bound to the prior file",
    );

    const buf = String(buffer.value ?? "");
    const clearedBuffer =
      buf.trim() === "" || rt.state.setDocCalls.some((t) => t == null || t === "");
    assert.ok(
      clearedBuffer,
      "newNote() must clear the editor buffer to an empty markdown session",
    );
    assert.equal(
      buf.includes("from the open file"),
      false,
      "newNote() must not keep the prior file body in the buffer",
    );

    assert.equal(
      rt.el("dirty").hidden,
      true,
      "newNote() must leave dirty false / a clean blank session",
    );

    const preview = rt.el("preview-body");
    const shown = previewText(preview);
    assert.equal(
      shown.includes(PRIOR_PREVIEW),
      false,
      "preview must not keep the prior file render after newNote()",
    );
    assert.ok(
      isEmptyPreview(preview) || !shown.includes(PRIOR_PREVIEW),
      "preview must be empty/safe after newNote() (blank render, not leftover HTML)",
    );

    const status = String(rt.el("status-path").textContent || "");
    assert.ok(
      status.trim() === "" || isUntitledCue(status),
      `#status-path must be cleared or show an untitled cue after newNote() (got ${JSON.stringify(status)})`,
    );
  } finally {
    rt.cleanup();
  }
});

test("without Save As, Save and autosave must not call write_workspace_file inventing a path", async () => {
  const rt = boot();
  const timers = installFakeTimers();
  try {
    await openFolderAndFile(rt);
    await invokeNewNote(rt);

    const ws = rt.win.lightmdWorkspace;
    assert.ok(
      isUnbound(ws && ws.relative),
      "precondition: newNote() must unbind currentRelative before Save/autosave",
    );

    const buffer = rt.el("editor-buffer");
    buffer.value = NEW_BODY;
    buffer.dispatchEvent({ type: "input", target: buffer });
    if (rt.state.scheduleCalls === 0 && typeof rt.win.lightmdScheduleAutoSave === "function") {
      if (typeof rt.win.lightmdSetDirty === "function") rt.win.lightmdSetDirty(true);
      rt.win.lightmdScheduleAutoSave();
    }

    const writesBefore = rt.writes.length;
    await rt.win.lightmdSave();
    await timers.flush();

    const newWrites = rt.writes.slice(writesBefore);
    assert.equal(
      newWrites.length,
      0,
      "Save/autosave must not invoke write_workspace_file while the buffer is unbound (no invented path)",
    );
    assert.equal(
      newWrites.some((w) => normalizeRel(w.relative) === FILE_A),
      false,
      "Save/autosave must not write the prior file after New Note",
    );
  } finally {
    timers.restore();
    rt.cleanup();
  }
});

test("saveAs({ path/root, relative or filename }) writes .md, binds currentRelative, dirty false, status-path shows path; subsequent Save/autosave write that path", async () => {
  const rt = boot();
  const timers = installFakeTimers();
  try {
    await openFolderAndFile(rt);
    await invokeNewNote(rt);

    const buffer = rt.el("editor-buffer");
    buffer.value = NEW_BODY;
    if (typeof rt.win.lightmdSetDirty === "function") rt.win.lightmdSetDirty(true);

    const writesBefore = rt.writes.length;
    await invokeSaveAs(rt, {
      path: FOLDER,
      root: FOLDER,
      relative: FRESH_REL,
      filename: FRESH_REL,
    });

    const created = rt.writes.slice(writesBefore);
    assert.ok(
      created.length > 0,
      "saveAs must invoke write_workspace_file (or write_file) for the chosen path",
    );
    const written = created.find((w) => hasMdExtension(w.relative));
    assert.ok(
      written,
      `saveAs must write a .md file (got ${JSON.stringify(created.map((w) => w.relative))})`,
    );
    assert.equal(
      normalizeRel(written.relative),
      FRESH_REL,
      "saveAs({ relative: \"fresh.md\" }) must write fresh.md",
    );
    assert.equal(
      String(written.contents ?? ""),
      NEW_BODY,
      "saveAs must persist the current editor buffer",
    );
    assert.equal(
      normalizeRel(written.path),
      FOLDER,
      "saveAs must write under the given path/root",
    );

    const ws = rt.win.lightmdWorkspace;
    assert.equal(
      normalizeRel(ws && ws.relative),
      FRESH_REL,
      "saveAs must bind currentRelative to the new file",
    );
    assert.equal(
      rt.el("dirty").hidden,
      true,
      "saveAs must clear dirty",
    );
    assert.ok(
      pathShows(rt.el("status-path").textContent, FRESH_REL),
      `#status-path must show the saved path (got ${JSON.stringify(rt.el("status-path").textContent)})`,
    );

    buffer.value = `${NEW_BODY}\nedit after bind\n`;
    buffer.dispatchEvent({ type: "input", target: buffer });
    const afterBind = rt.writes.length;
    await rt.win.lightmdSave();
    const saveWrites = rt.writes.slice(afterBind);
    assert.ok(
      saveWrites.some((w) => normalizeRel(w.relative) === FRESH_REL),
      "subsequent Save must write the Save As path",
    );

    if (typeof rt.win.lightmdSetDirty === "function") rt.win.lightmdSetDirty(true);
    const beforeAuto = rt.writes.length;
    rt.win.lightmdScheduleAutoSave();
    await timers.flush();
    const autoWrites = rt.writes.slice(beforeAuto);
    assert.ok(
      autoWrites.some((w) => normalizeRel(w.relative) === FRESH_REL),
      "subsequent autosave must write the Save As path",
    );
  } finally {
    timers.restore();
    rt.cleanup();
  }
});

test("saveAs defaults omitted extension to .md", async () => {
  const rt = boot();
  try {
    await openFolderAndFile(rt);
    await invokeNewNote(rt);
    rt.el("editor-buffer").value = NEW_BODY;

    const writesBefore = rt.writes.length;
    await invokeSaveAs(rt, {
      path: FOLDER,
      root: FOLDER,
      relative: PLAIN_NAME,
      filename: PLAIN_NAME,
    });
    const created = rt.writes.slice(writesBefore);
    const written = created[created.length - 1];
    assert.ok(written, "saveAs must write when filename has no extension");
    assert.ok(
      hasMdExtension(written.relative),
      `saveAs must default omitted extension to .md (wrote ${JSON.stringify(written.relative)})`,
    );
    assert.equal(
      normalizeRel(written.relative),
      `${PLAIN_NAME}.md`,
      "saveAs({ filename: \"untitled-plain\" }) must write untitled-plain.md",
    );
    const ws = rt.win.lightmdWorkspace;
    assert.equal(
      normalizeRel(ws && ws.relative),
      `${PLAIN_NAME}.md`,
      "currentRelative must bind the .md path when extension was omitted",
    );
  } finally {
    rt.cleanup();
  }
});

test("saveAs does not clobber an existing file without confirm, or picker/API rejects overwrite", async () => {
  const rt = boot();
  try {
    await openFolderAndFile(rt);
    await invokeNewNote(rt);
    rt.el("editor-buffer").value = "should not replace existing a.md\n";
    rt.state.confirmResult = false;

    const saveAs = resolveSaveAs(rt);
    assert.ok(
      typeof saveAs === "function",
      "missing saveAs() (window.lightmdSaveAs / saveAs / export saveAs)",
    );

    const writesBefore = rt.writes.length;
    const original = rt.files.get(EXISTING_REL);
    let rejected = false;
    let result;
    try {
      result = await invokeSaveAs(rt, {
        path: FOLDER,
        root: FOLDER,
        relative: EXISTING_REL,
        filename: EXISTING_REL,
      });
    } catch {
      rejected = true;
    }
    if (result === false) rejected = true;
    if (result == null && rt.writes.length === writesBefore) rejected = true;

    const clobbers = rt.writes
      .slice(writesBefore)
      .filter((w) => normalizeRel(w.relative) === EXISTING_REL);
    const asked = rt.confirms.length > 0;

    assert.equal(
      clobbers.length,
      0,
      "saveAs must not overwrite an existing file when confirm is cancelled or the picker/API rejects clobber",
    );
    assert.equal(
      rt.files.get(EXISTING_REL),
      original,
      "existing target contents must stay unchanged without an overwrite confirm",
    );
    assert.ok(
      asked || rejected,
      "one clear rule: confirm before overwrite OR picker/API rejects clobber (got silent success)",
    );
  } finally {
    rt.cleanup();
  }
});

test("open-folder and open-file flows still bind workspace and load the file body", async () => {
  const rt = boot();
  try {
    await rt.win.lightmdOpenFolder(FOLDER);
    const listed = rt.invokes.filter((i) => i.cmd === "list_workspace");
    assert.ok(listed.length > 0, "Open Folder must still invoke list_workspace");
    assert.equal(
      rt.win.lightmdWorkspace.path,
      FOLDER,
      "Open Folder must still bind lightmdWorkspace.path",
    );

    await rt.win.lightmdOpenFile(FILE_A);
    assert.equal(
      rt.win.lightmdWorkspace.relative,
      FILE_A,
      "Open File must still bind currentRelative",
    );
    assert.equal(
      rt.el("editor-buffer").value,
      BODY_A,
      "Open File must still load the file body into the editor buffer",
    );
    assert.equal(
      rt.el("status-path").textContent,
      FILE_A,
      "Open File must still show the relative path on #status-path",
    );
    assert.equal(
      rt.el("dirty").hidden,
      true,
      "Open File must still leave dirty false after a successful load",
    );
  } finally {
    rt.cleanup();
  }
});

test("saveAs writes stay confined (no ../ escape); reuse write_file confinement", async () => {
  const rt = boot();
  try {
    await openFolderAndFile(rt);
    await invokeNewNote(rt);
    rt.el("editor-buffer").value = "must not land outside the workspace\n";

    const saveAs = resolveSaveAs(rt);
    assert.ok(
      typeof saveAs === "function",
      "missing saveAs() (window.lightmdSaveAs / saveAs / export saveAs)",
    );

    const writesBefore = rt.writes.length;
    let rejected = false;
    try {
      await invokeSaveAs(rt, {
        path: FOLDER,
        root: FOLDER,
        relative: ESCAPE_REL,
        filename: ESCAPE_REL,
      });
    } catch {
      rejected = true;
    }

    const escapedWrites = rt.writes
      .slice(writesBefore)
      .filter((w) => isEscapingRelative(w.relative));
    assert.equal(
      escapedWrites.length,
      0,
      "saveAs must not successfully write a parent-relative path (write_file confinement)",
    );

    const ws = rt.win.lightmdWorkspace;
    assert.equal(
      isEscapingRelative(ws && ws.relative),
      false,
      "currentRelative must not bind an escaped ../ path",
    );
    assert.ok(
      rejected ||
        rt.attemptedWrites.some((w) => isEscapingRelative(w.relative)) ||
        isUnbound(ws && ws.relative),
      "saveAs must reject ../ (or leave the buffer unbound) rather than escaping the workspace root",
    );
  } finally {
    rt.cleanup();
  }
});

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceFiles, collectFiles } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const fixturesDir = join(root, "tests", "fixtures");
const workspaceDir = join(fixturesDir, "workspace");
const LAYOUT_KEY = "lightmd.layout";

const SESSION_FILE_NAMES = [
  "session.js",
  "session.mjs",
  "session-restore.js",
  "sessionRestore.js",
];

const PERSIST_NAMES = [
  "persistSession",
  "saveSession",
  "storeSession",
  "writeSession",
  "persist",
];

const RESTORE_NAMES = [
  "restoreSession",
  "loadSession",
  "applyStoredSession",
  "initSession",
  "readSession",
  "restore",
];

const GET_NAMES = ["getSession", "readSessionState", "sessionState"];


function loadSources() {
  return loadSourceFiles();
}

function joinedSource(files = loadSources()) {
  return files.map((f) => f.text).join("\n");
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asBool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function pickFn(mod, names) {
  if (!mod || typeof mod !== "object") return null;
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  if (mod.default && typeof mod.default === "object") {
    for (const name of names) {
      if (typeof mod.default[name] === "function") return mod.default[name];
    }
  }
  return null;
}

function pickObject(mod, names) {
  if (!mod || typeof mod !== "object") return null;
  for (const name of names) {
    const value = mod[name];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  if (mod.default && typeof mod.default === "object") {
    for (const name of names) {
      const value = mod.default[name];
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    }
  }
  return null;
}

function sourceLooksLikeSession(text) {
  return /persistSession|restoreSession|lastFolder|lastFile|sessionRestore|defaultFolder/.test(
    text,
  );
}

function sessionCandidatePaths() {
  const files = collectFiles(srcDir);
  const preferred = SESSION_FILE_NAMES.map((name) => join(srcDir, name)).filter(
    (p) => existsSync(p),
  );
  const named = [];
  const others = [];
  for (const p of files) {
    if (!/\.(js|mjs|cjs)$/i.test(p)) continue;
    if (/editor\.bundle\.js$/i.test(p)) continue;
    if (preferred.includes(p)) continue;
    if (/session/i.test(p) || sourceLooksLikeSession(readFileSync(p, "utf8"))) {
      named.push(p);
    } else {
      others.push(p);
    }
  }
  return [...preferred, ...named, ...others];
}

function installLocalStorage(existing) {
  if (existing && typeof existing.getItem === "function") {
    globalThis.localStorage = existing;
    return existing;
  }
  const map = new Map();
  const ls = {
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
  globalThis.localStorage = ls;
  return ls;
}

function mockEl(id) {
  return {
    id,
    style: { setProperty() {}, width: "", minWidth: "", flex: "", flexBasis: "" },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    hidden: false,
    checked: false,
    textContent: "",
    setAttribute() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
  };
}

function installDocument() {
  const byId = new Map();
  const doc = {
    documentElement: mockEl("html"),
    body: mockEl("body"),
    getElementById(id) {
      const key = String(id);
      if (!byId.has(key)) byId.set(key, mockEl(key));
      return byId.get(key);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return mockEl(String(tag));
    },
  };
  globalThis.document = doc;
  if (!globalThis.window) globalThis.window = globalThis;
  return doc;
}

function pickSessionRestorePref(mod, seenDefault = false) {
  if (!mod || typeof mod !== "object") return null;
  const names = [
    "sessionRestore",
    "session_restore",
    "SESSION_RESTORE",
    "restoreSession",
    "restoreOnLaunch",
    "restoreLastSession",
  ];
  for (const name of names) {
    if (!(name in mod)) continue;
    const value = mod[name];
    if (typeof value === "boolean") return { enabled: value };
    if (value && typeof value === "object") {
      const enabled = firstOf(
        asBool(value.enabled),
        asBool(value.on),
        asBool(value.restore),
      );
      if (typeof enabled === "boolean") return { enabled };
    }
  }
  for (const wrap of [
    "session",
    "settings",
    "config",
    "defaults",
    "default",
    "prefs",
    "preferences",
  ]) {
    if (wrap === "default" && seenDefault) continue;
    const obj = mod[wrap];
    if (!obj || typeof obj !== "object") continue;
    const nested = pickSessionRestorePref(obj, wrap === "default" || seenDefault);
    if (nested) return nested;
  }
  if (!seenDefault && mod.default && typeof mod.default === "object") {
    const nested = pickSessionRestorePref(mod.default, true);
    if (nested) return nested;
  }
  return null;
}

function configFromSource(src) {
  const match =
    src.match(/\bsession[-_]?restore(?:Enabled|On)?\s*[:=]\s*(true|false)/i) ||
    src.match(/\brestoreSession\s*[:=]\s*(true|false)/) ||
    src.match(
      /\bsessionRestore[\s\S]{0,200}?\b(?:enabled|on|restore)\s*:\s*(true|false)/i,
    ) ||
    src.match(
      /\b(?:enabled|on|restore)\s*:\s*(true|false)[\s\S]{0,200}?\bsession[-_]?restore/i,
    );
  if (!match) return null;
  return { enabled: match[1] === "true" };
}

function pickDefaultFolder(mod) {
  if (!mod || typeof mod !== "object") return undefined;
  const direct = firstOf(
    typeof mod.defaultFolder === "string" || mod.defaultFolder === null
      ? mod.defaultFolder
      : undefined,
    typeof mod.DEFAULT_FOLDER === "string" ? mod.DEFAULT_FOLDER : undefined,
  );
  if (direct !== undefined) return direct;
  for (const wrap of [
    "session",
    "sessionRestore",
    "defaults",
    "default",
    "settings",
    "config",
    "prefs",
  ]) {
    const obj = mod[wrap];
    if (!obj || typeof obj !== "object") continue;
    const value = firstOf(
      typeof obj.defaultFolder === "string" || obj.defaultFolder === null
        ? obj.defaultFolder
        : undefined,
      typeof obj.folder === "string" ? obj.folder : undefined,
      typeof obj.default === "string" ? obj.default : undefined,
    );
    if (value !== undefined) return value;
  }
  if (mod.default && typeof mod.default === "object") {
    return pickDefaultFolder(mod.default);
  }
  return undefined;
}

function looksLikeSessionShape(value) {
  if (!value || typeof value !== "object") return false;
  return (
    "lastFolder" in value ||
    "lastFile" in value ||
    "folder" in value ||
    "theme" in value ||
    "editorTheme" in value ||
    "htmlJs" in value ||
    "htmlJsEnabled" in value ||
    "sessionRestore" in value ||
    "defaultFolder" in value
  );
}

function asSessionApi(mod) {
  if (!mod || typeof mod !== "object") return null;
  const persist = pickFn(mod, PERSIST_NAMES);
  const restore = pickFn(mod, RESTORE_NAMES);
  const getSession = pickFn(mod, GET_NAMES);
  const sessionObj = pickObject(mod, ["session", "sessionState", "SESSION"]);
  const restorePref = pickSessionRestorePref(mod);
  const defaultFolder = pickDefaultFolder(mod);
  const lastFolder =
    typeof mod.lastFolder === "string" || mod.lastFolder === null
      ? mod.lastFolder
      : sessionObj &&
          (typeof sessionObj.lastFolder === "string" || sessionObj.lastFolder === null)
        ? sessionObj.lastFolder
        : undefined;
  if (
    !persist &&
    !restore &&
    !getSession &&
    !sessionObj &&
    !restorePref &&
    lastFolder === undefined &&
    defaultFolder === undefined &&
    !looksLikeSessionShape(mod)
  ) {
    return null;
  }
  if (typeof persist === "function" && /Layout$/.test(persist.name || "") && !restorePref) {
    return null;
  }
  return {
    persist,
    restore,
    getSession,
    sessionObj,
    restorePref,
    defaultFolder,
    raw: mod,
  };
}

async function importFresh(filePath, storage) {
  installDocument();
  installLocalStorage(storage);
  const href = pathToFileURL(filePath).href;
  return import(`${href}?session-restore=${Date.now()}-${Math.random()}`);
}

async function loadSessionApi(storage = installLocalStorage()) {
  const files = loadSources();
  const src = joinedSource(files);
  installDocument();
  installLocalStorage(storage);
  let api = null;
  let filePath = null;
  let mod = null;
  for (const p of sessionCandidatePaths()) {
    try {
      const loaded = await importFresh(p, storage);
      const found = asSessionApi(loaded);
      if (found && (found.persist || found.restore || found.restorePref || found.sessionObj)) {
        api = found;
        filePath = p;
        mod = loaded;
        if (found.persist && found.restore) break;
      }
    } catch {
      // DOM or otherwise unusable in Node: keep looking.
    }
  }
  return { api, filePath, mod, src, storage, files };
}

async function relaunch(filePath, storage) {
  assert.ok(filePath, "missing session restore (src/session.js persist/restore exports)");
  const mod = await importFresh(filePath, storage);
  const api = asSessionApi(mod);
  assert.ok(
    api && typeof api.persist === "function" && typeof api.restore === "function",
    "missing session restore (persist/restore exports)",
  );
  return { api, mod, storage };
}

function htmlJsEnabled(value) {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object") {
    return firstOf(
      asBool(value.enabled),
      asBool(value.on),
      asBool(value.javascript),
      asBool(value.js),
      asBool(value.allowScripts),
      asBool(value.htmlJs),
    );
  }
  return undefined;
}

function normalizeName(name) {
  return String(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\+/g, " plus")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sameTheme(a, b) {
  if (a == null || b == null) return false;
  return normalizeName(a) === normalizeName(b);
}

function sameFolder(a, b) {
  if (a == null || b == null) return false;
  try {
    return resolve(String(a)) === resolve(String(b));
  } catch {
    return String(a).replace(/[/\\]+$/, "") === String(b).replace(/[/\\]+$/, "");
  }
}

function sameFile(a, b) {
  if (a == null || b == null) return false;
  const na = String(a).replace(/\\/g, "/");
  const nb = String(b).replace(/\\/g, "/");
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

function normalizeSession(value) {
  if (!value || typeof value !== "object") return null;
  const nested = firstOf(
    value.session,
    value.sessionState,
    value.state,
    value.restored,
  );
  const src =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? { ...value, ...nested }
      : value;
  const lastFolder = firstOf(
    src.lastFolder,
    src.folder,
    src.workspace,
    src.root,
    src.workspaceRoot,
    src.lastWorkspace,
    src.path,
  );
  const lastFile = firstOf(
    src.lastFile,
    src.file,
    src.relative,
    src.lastPath,
    src.openFile,
    src.fileRelative,
  );
  const themeName = firstOf(
    typeof src.theme === "string" ? src.theme : undefined,
    src.theme?.name,
    src.editorTheme,
    src.editorPalette,
    src.previewTheme,
    src.previewPalette,
  );
  const htmlJs = firstOf(
    htmlJsEnabled(src.htmlJs),
    htmlJsEnabled(src.htmlJS),
    htmlJsEnabled(src.htmlJavaScript),
    asBool(src.htmlJsEnabled),
    asBool(src.htmlJavaScriptEnabled),
    asBool(src.allowScripts),
  );
  if (
    lastFolder === undefined &&
    lastFile === undefined &&
    themeName === undefined &&
    htmlJs === undefined
  ) {
    return null;
  }
  return { lastFolder, lastFile, theme: themeName, htmlJs, raw: src };
}

function readSession(api, restored) {
  if (typeof api.getSession === "function") {
    try {
      const got = normalizeSession(api.getSession());
      if (got) return got;
    } catch {
      // keep looking
    }
  }
  const fromRestore = normalizeSession(restored);
  if (fromRestore) return fromRestore;
  const fromObj = normalizeSession(api.sessionObj);
  if (fromObj) return fromObj;
  return normalizeSession(api.raw);
}

async function callPersist(api, snapshot) {
  assert.equal(
    typeof api.persist,
    "function",
    "missing session restore (persist export)",
  );
  if (typeof api.raw.openFolder === "function") {
    await api.raw.openFolder(snapshot.lastFolder);
  }
  if (typeof api.raw.openFile === "function") {
    await api.raw.openFile(snapshot.lastFile);
  }
  if (typeof api.raw.setTheme === "function") {
    api.raw.setTheme(snapshot.theme);
  }
  if (typeof api.raw.setHtmlJsEnabled === "function") {
    api.raw.setHtmlJsEnabled(snapshot.htmlJs);
  } else if (typeof api.raw.setHtmlJs === "function") {
    api.raw.setHtmlJs(snapshot.htmlJs);
  }
  const attempts = [
    () => api.persist(snapshot),
    () =>
      api.persist({
        folder: snapshot.lastFolder,
        file: snapshot.lastFile,
        theme: snapshot.theme,
        htmlJsEnabled: snapshot.htmlJs,
      }),
    () => api.persist(snapshot.lastFolder, snapshot.lastFile),
    () => api.persist(),
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      const result = attempt();
      if (result && typeof result.then === "function") await result;
      return true;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("persistSession failed");
}

async function callRestore(api, extra) {
  assert.equal(
    typeof api.restore,
    "function",
    "missing session restore (restore export)",
  );
  const attempts = extra
    ? [() => api.restore(extra), () => api.restore()]
    : [() => api.restore(), () => api.restore(extra)];
  let lastErr;
  for (const attempt of attempts) {
    try {
      let result = attempt();
      if (result && typeof result.then === "function") result = await result;
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("restoreSession failed");
}

function sampleSnapshot() {
  return {
    lastFolder: workspaceDir,
    lastFile: "note.md",
    theme: "Monokai",
    htmlJs: true,
  };
}

function storageEntries(ls) {
  const out = [];
  if (!ls) return out;
  const len = ls.length ?? 0;
  if (len && typeof ls.key === "function") {
    for (let i = 0; i < len; i++) {
      const key = ls.key(i);
      if (key == null) continue;
      out.push({ key: String(key), value: ls.getItem(key) });
    }
  }
  return out;
}

function clearSessionStorage(ls) {
  for (const { key } of storageEntries(ls)) {
    if (key === LAYOUT_KEY) continue;
    ls.removeItem(key);
  }
}

function confinedToWorkspace(rootPath, file) {
  if (file == null || file === "" || file === false) return true;
  const s = String(file).replace(/\\/g, "/");
  if (s === "../outside.md" || /(^|\/)\.\.\/outside\.md$/.test(s)) return false;
  const resolved = isAbsolute(s) ? resolve(s) : resolve(rootPath, s);
  const rel = relative(resolve(rootPath), resolved);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertRestoredSnapshot(state, snapshot, message) {
  assert.ok(state, message);
  assert.ok(
    sameFolder(state.lastFolder, snapshot.lastFolder),
    `${message} (last folder)`,
  );
  assert.ok(
    sameFile(state.lastFile, snapshot.lastFile),
    `${message} (last file)`,
  );
  assert.ok(
    sameTheme(state.theme, snapshot.theme),
    `${message} (theme)`,
  );
  // HTML JS is per file and in memory only, so it never comes back on relaunch.
  assert.notEqual(state.htmlJs, true, `${message} (HTML JS must not be restored)`);
}

test("relaunch restores last folder, last file, and themes, but not HTML JS", async () => {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  try {
    const storage = installLocalStorage();
    const loaded = await loadSessionApi(storage);
    assert.ok(
      loaded.api &&
        typeof loaded.api.persist === "function" &&
        typeof loaded.api.restore === "function",
      "missing session restore (persist/restore exports); relaunch must restore last folder, last file, and theme",
    );
    const snapshot = sampleSnapshot();
    await callPersist(loaded.api, snapshot);

    const relaunched = await relaunch(loaded.filePath, storage);
    const restored = await callRestore(relaunched.api);
    const state = readSession(relaunched.api, restored);
    assertRestoredSnapshot(
      state,
      snapshot,
      "after opening a folder+file, setting theme and HTML JS, and quitting, relaunch must restore last folder, last file, and theme, and leave HTML JS off",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
});

test("session restore default on", async () => {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  try {
    const loaded = await loadSessionApi();
    const pref =
      loaded.api?.restorePref ||
      pickSessionRestorePref(loaded.mod) ||
      configFromSource(loaded.src);
    assert.ok(
      pref,
      "session restore must default on (testable export/object)",
    );
    assert.equal(
      pref.enabled,
      true,
      "session restore must default on (testable export/object)",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
});

test("default folder used only when no session exists", async () => {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  try {
    const storage = installLocalStorage();
    const loaded = await loadSessionApi(storage);
    assert.ok(
      loaded.api &&
        typeof loaded.api.persist === "function" &&
        typeof loaded.api.restore === "function",
      "missing session restore (persist/restore exports)",
    );
    const defaultFolder = firstOf(
      loaded.api.defaultFolder,
      pickDefaultFolder(loaded.mod),
    );
    assert.notEqual(
      defaultFolder,
      undefined,
      "missing defaultFolder (used only when no session exists)",
    );
    const snapshot = sampleSnapshot();
    assert.equal(
      sameFolder(snapshot.lastFolder, defaultFolder),
      false,
      "test last folder must differ from defaultFolder",
    );
    await callPersist(loaded.api, snapshot);

    const withSession = await relaunch(loaded.filePath, storage);
    const restoredWith = await callRestore(withSession.api, { defaultFolder });
    const stateWith = readSession(withSession.api, restoredWith);
    assert.ok(
      sameFolder(stateWith?.lastFolder, snapshot.lastFolder),
      "if a last folder is stored, do not fall back to defaultFolder",
    );
    assert.equal(
      sameFolder(stateWith?.lastFolder, defaultFolder),
      false,
      "if a last folder is stored, do not fall back to defaultFolder",
    );

    clearSessionStorage(storage);
    const withoutSession = await relaunch(loaded.filePath, storage);
    const restoredWithout = await callRestore(withoutSession.api, { defaultFolder });
    const stateWithout = readSession(withoutSession.api, restoredWithout);
    const used = stateWithout?.lastFolder ?? null;
    const expected = defaultFolder === "" ? defaultFolder : defaultFolder;
    assert.ok(
      (expected === "" || expected == null
        ? used == null || used === ""
        : sameFolder(used, expected)),
      "default folder must be used only when no session exists",
    );
    assert.equal(
      sameFolder(used, snapshot.lastFolder),
      false,
      "default folder must be used only when no session exists (do not keep a last folder after session is gone)",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
});

test("restored paths stay confined to the workspace", async () => {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  try {
    const storage = installLocalStorage();
    const loaded = await loadSessionApi(storage);
    assert.ok(
      loaded.api &&
        typeof loaded.api.persist === "function" &&
        typeof loaded.api.restore === "function",
      "missing session restore (persist/restore exports)",
    );
    await callPersist(loaded.api, {
      lastFolder: workspaceDir,
      lastFile: "../outside.md",
      theme: "Monokai",
      htmlJs: false,
    });
    const relaunched = await relaunch(loaded.filePath, storage);
    const restored = await callRestore(relaunched.api);
    const state = readSession(relaunched.api, restored);
    const opened = state?.lastFile;
    assert.equal(
      confinedToWorkspace(workspaceDir, opened),
      true,
      "restored file paths must stay workspace-relative / confined (same root-relative checks as read_file); lastFile of ../outside.md must not be opened",
    );
    assert.equal(
      opened == null || opened === "" || opened === false
        ? true
        : !String(opened).replace(/\\/g, "/").includes("../outside.md"),
      true,
      "a lastFile of ../outside.md must not be opened",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
});

test("session persist does not overwrite lightmd.layout", async () => {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  try {
    const storage = installLocalStorage();
    const sentinel = JSON.stringify({
      order: ["preview", "editor", "explorer"],
      marker: "layout-must-stay",
    });
    storage.setItem(LAYOUT_KEY, sentinel);
    const loaded = await loadSessionApi(storage);
    assert.ok(
      loaded.api && typeof loaded.api.persist === "function",
      "missing session restore (persist export)",
    );
    await callPersist(loaded.api, sampleSnapshot());
    assert.equal(
      storage.getItem(LAYOUT_KEY),
      sentinel,
      "session persist must not overwrite lightmd.layout",
    );
    const other = storageEntries(storage).filter((entry) => entry.key !== LAYOUT_KEY);
    assert.ok(
      other.length > 0,
      "session persist must not overwrite lightmd.layout (store session under a different key)",
    );
    assert.equal(
      other.some((entry) => entry.key === LAYOUT_KEY),
      false,
      "session persist must not overwrite lightmd.layout",
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLs;
  }
});

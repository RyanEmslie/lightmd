const STORAGE_KEY = "lightmd.session";

export const session = {
  restore: true,
  defaultFolder: "",
  lastFolder: null,
  lastFile: null,
  editorTheme: null,
  previewTheme: null,
  htmlJs: false,
};

export const sessionRestore = true;

function doc() {
  return typeof globalThis.document !== "undefined" ? globalThis.document : null;
}

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function tauriInvoke() {
  try {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    return typeof invoke === "function" ? invoke : null;
  } catch {
    return null;
  }
}

function isAbsolutePath(p) {
  const s = String(p);
  return s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s);
}

function hasDotDot(p) {
  const s = String(p).replace(/\\/g, "/");
  if (s.startsWith("..")) return true;
  return s.split("/").some((part) => part === "..");
}

function confinedLastFile(folder, file) {
  if (file == null || file === "" || file === false) return null;
  const s = String(file).replace(/\\/g, "/");
  if (hasDotDot(s)) return null;
  if (isAbsolutePath(s)) {
    if (folder == null || folder === "") return null;
    const root = String(folder).replace(/\\/g, "/").replace(/\/+$/, "");
    if (s === root || !s.startsWith(`${root}/`)) return null;
    const rel = s.slice(root.length + 1);
    if (!rel || hasDotDot(rel)) return null;
    return rel;
  }
  return s;
}

function asBool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function htmlJsValue(value) {
  const direct = asBool(value);
  if (direct !== undefined) return direct;
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

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function payload() {
  return {
    restore: session.restore,
    defaultFolder: session.defaultFolder,
    lastFolder: session.lastFolder,
    lastFile: session.lastFile,
    folder: session.lastFolder,
    file: session.lastFile,
    editorTheme: session.editorTheme,
    previewTheme: session.previewTheme,
    htmlJs: session.htmlJs,
  };
}

function mergePartial(partial) {
  if (!partial || typeof partial !== "object") return;
  if (typeof partial.restore === "boolean") session.restore = partial.restore;
  if ("defaultFolder" in partial) session.defaultFolder = partial.defaultFolder;
  if ("lastFolder" in partial) session.lastFolder = partial.lastFolder;
  else if ("folder" in partial) session.lastFolder = partial.folder;
  if ("lastFile" in partial) session.lastFile = partial.lastFile;
  else if ("file" in partial) session.lastFile = partial.file;
  if ("editorTheme" in partial) session.editorTheme = partial.editorTheme;
  if ("previewTheme" in partial) session.previewTheme = partial.previewTheme;
  const htmlJs = firstOf(htmlJsValue(partial.htmlJs), asBool(partial.htmlJsEnabled));
  if (htmlJs !== undefined) session.htmlJs = htmlJs;
}

function writeSession() {
  const ls = storage();
  if (!ls || typeof ls.setItem !== "function") return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(payload()));
  } catch {
    // ignore quota / missing storage
  }
}

export function persistSession(partial, fileArg) {
  if (typeof partial === "string") {
    session.lastFolder = partial;
    if (typeof fileArg === "string" || fileArg == null) {
      if (arguments.length > 1) session.lastFile = fileArg;
    }
  } else if (partial && typeof partial === "object") {
    mergePartial(partial);
  }
  writeSession();
  return session;
}

function storedFolder(stored) {
  if (!stored || typeof stored !== "object") return null;
  const value = firstOf(stored.lastFolder, stored.folder);
  if (typeof value === "string" && value !== "") return value;
  return null;
}

function syncSessionControls() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const editorSelect = d.getElementById("editor-theme");
  if (editorSelect && typeof session.editorTheme === "string") {
    editorSelect.value = session.editorTheme;
  }
  const previewSelect = d.getElementById("preview-theme");
  if (previewSelect && typeof session.previewTheme === "string") {
    previewSelect.value = session.previewTheme;
  }
  const htmlJsEl = d.getElementById("html-js");
  if (htmlJsEl && typeof session.htmlJs === "boolean") {
    htmlJsEl.checked = session.htmlJs;
  }
}

function applyFileBody(body) {
  const d = doc();
  const buffer = d && typeof d.getElementById === "function" ? d.getElementById("editor-buffer") : null;
  if (buffer) buffer.value = body;
  const statusPath = d && typeof d.getElementById === "function" ? d.getElementById("status-path") : null;
  if (statusPath && session.lastFile) statusPath.textContent = session.lastFile;
  try {
    globalThis.lightmdEditor?.setDoc?.(body);
  } catch {
    // editor not mounted yet
  }
}

async function applyThemeHelpers() {
  try {
    const palettes = await import("./palettes.js");
    if (typeof session.editorTheme === "string" && typeof palettes.setEditorTheme === "function") {
      palettes.setEditorTheme(session.editorTheme);
    }
    if (typeof session.previewTheme === "string" && typeof palettes.setPreviewTheme === "function") {
      palettes.setPreviewTheme(session.previewTheme);
    }
  } catch {
    // Node import / missing palettes
  }
  try {
    const html = await import("./html-viewer.js");
    if (typeof html.setHtmlJsEnabled === "function") {
      html.setHtmlJsEnabled(!!session.htmlJs);
    }
  } catch {
    // Node import / missing html-viewer
  }
}

async function restoreWorkspace() {
  if (session.lastFolder && typeof globalThis.lightmdOpenFolder === "function") {
    try {
      await globalThis.lightmdOpenFolder(session.lastFolder);
    } catch {
      // folder may be gone
    }
  }
  if (!session.lastFile) return;
  const invoke = tauriInvoke();
  if (!invoke) return;
  if (!session.lastFolder) {
    session.lastFile = null;
    return;
  }
  try {
    const body = await invoke("read_workspace_file", {
      path: session.lastFolder,
      relative: session.lastFile,
    });
    applyFileBody(body);
    if (typeof globalThis.lightmdOpenFile === "function") {
      await globalThis.lightmdOpenFile(session.lastFile);
    }
  } catch {
    session.lastFile = null;
  }
}

export function restoreSession(extra) {
  const ls = storage();
  const raw = ls && typeof ls.getItem === "function" ? ls.getItem(STORAGE_KEY) : null;
  let stored = null;
  if (raw != null && raw !== "") {
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
  }
  const fallbackDefault =
    extra && typeof extra === "object" && extra.defaultFolder !== undefined
      ? extra.defaultFolder
      : session.defaultFolder;
  const lastFolder = storedFolder(stored);
  if (!lastFolder) {
    if (fallbackDefault !== undefined) session.lastFolder = fallbackDefault;
  } else {
    session.lastFolder = lastFolder;
    const lastFile = firstOf(stored.lastFile, stored.file);
    if (lastFile !== undefined) session.lastFile = lastFile;
    if (stored.editorTheme !== undefined) session.editorTheme = stored.editorTheme;
    if (stored.previewTheme !== undefined) session.previewTheme = stored.previewTheme;
    const htmlJs = firstOf(htmlJsValue(stored.htmlJs), asBool(stored.htmlJsEnabled));
    if (htmlJs !== undefined) session.htmlJs = htmlJs;
    if (typeof stored.restore === "boolean") session.restore = stored.restore;
    if ("defaultFolder" in stored) session.defaultFolder = stored.defaultFolder;
  }
  session.lastFile = confinedLastFile(session.lastFolder, session.lastFile);
  syncSessionControls();
  return Promise.resolve()
    .then(() => applyThemeHelpers())
    .then(() => (session.restore ? restoreWorkspace() : session))
    .then(() => session)
    .catch(() => session);
}

export function getSession() {
  return session;
}

function bindSessionControls() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const editorSelect = d.getElementById("editor-theme");
  if (editorSelect && typeof editorSelect.addEventListener === "function") {
    editorSelect.addEventListener("change", () => {
      persistSession({ editorTheme: editorSelect.value });
    });
  }
  const previewSelect = d.getElementById("preview-theme");
  if (previewSelect && typeof previewSelect.addEventListener === "function") {
    previewSelect.addEventListener("change", () => {
      persistSession({ previewTheme: previewSelect.value });
    });
  }
  const htmlJsEl = d.getElementById("html-js");
  if (htmlJsEl && typeof htmlJsEl.addEventListener === "function") {
    htmlJsEl.addEventListener("change", () => {
      persistSession({ htmlJs: !!htmlJsEl.checked });
    });
  }
}

try {
  bindSessionControls();
} catch {
  // mock document has no addEventListener
}

try {
  globalThis.lightmdPersistSession = persistSession;
  globalThis.lightmdRestoreSession = restoreSession;
  globalThis.lightmdGetSession = getSession;
} catch {
  // non-window hosts
}

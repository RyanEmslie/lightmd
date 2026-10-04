const STORAGE_KEY = "lightmd.session";

export const session = {
  restore: true,
  defaultFolder: "",
  lastFolder: null,
  lastFile: null,
  theme: null,
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
    theme: session.theme,
  };
}

function mergePartial(partial) {
  if (!partial || typeof partial !== "object") return;
  if (typeof partial.restore === "boolean") session.restore = partial.restore;
  if ("defaultFolder" in partial) session.defaultFolder = partial.defaultFolder;
  const prevFolder = session.lastFolder;
  if ("lastFolder" in partial) session.lastFolder = partial.lastFolder;
  else if ("folder" in partial) session.lastFolder = partial.folder;
  if ("lastFile" in partial) session.lastFile = partial.lastFile;
  else if ("file" in partial) session.lastFile = partial.file;
  else if (("lastFolder" in partial || "folder" in partial) && session.lastFolder !== prevFolder) {
    session.lastFile = null;
  }
  const nextTheme = firstOf(
    typeof partial.theme === "string" ? partial.theme : undefined,
    typeof partial.theme?.name === "string" ? partial.theme.name : undefined,
    typeof partial.editorTheme === "string" ? partial.editorTheme : undefined,
    typeof partial.previewTheme === "string" ? partial.previewTheme : undefined,
  );
  if (typeof nextTheme === "string") session.theme = nextTheme;
  // HTML JavaScript is per file and in memory only (html-viewer.js): never saved.
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
    const prevFolder = session.lastFolder;
    session.lastFolder = partial;
    if (arguments.length > 1) {
      if (typeof fileArg === "string" || fileArg == null) {
        session.lastFile = fileArg;
      }
    } else if (partial !== prevFolder) {
      session.lastFile = null;
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

function pickThemeName(stored) {
  if (!stored || typeof stored !== "object") return null;
  const candidates = [
    typeof stored.theme === "string" ? stored.theme : undefined,
    stored.theme && typeof stored.theme.name === "string" ? stored.theme.name : undefined,
    typeof stored.editorTheme === "string" ? stored.editorTheme : undefined,
    typeof stored.previewTheme === "string" ? stored.previewTheme : undefined,
  ];
  for (const name of candidates) {
    if (typeof name === "string" && name !== "") return name;
  }
  return null;
}

function syncSessionControls() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const settingsTheme = d.getElementById("settings-theme");
  if (settingsTheme && typeof session.theme === "string") {
    settingsTheme.value = session.theme;
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
    if (typeof session.theme === "string" && typeof palettes.setTheme === "function") {
      palettes.setTheme(session.theme);
    }
  } catch {
    // Node import / missing palettes
  }
}

async function restoreWorkspace() {
  const folder = session.lastFolder;
  const file = session.lastFile;
  if (folder && typeof globalThis.lightmdOpenFolder === "function") {
    try {
      await globalThis.lightmdOpenFolder(folder);
    } catch {
      // folder may be gone
    }
  }
  if (!file) return;
  if (!folder) {
    session.lastFile = null;
    return;
  }
  try {
    if (typeof globalThis.lightmdOpenFile === "function") {
      // The app glue reads, renders and tabs the file itself.
      await globalThis.lightmdOpenFile(file);
    } else {
      const invoke = tauriInvoke();
      if (!invoke) return;
      applyFileBody(await invoke("read_workspace_file", { path: folder, relative: file }));
    }
    persistSession({ lastFile: file, file: file });
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
  if (stored && typeof stored === "object") {
    const pickedTheme = pickThemeName(stored);
    if (pickedTheme) session.theme = pickedTheme;
    // Older versions saved htmlJs / htmlJsEnabled; they are ignored.
    if (typeof stored.restore === "boolean") session.restore = stored.restore;
    if ("defaultFolder" in stored) session.defaultFolder = stored.defaultFolder;
  }
  if (!lastFolder) {
    if (fallbackDefault !== undefined) session.lastFolder = fallbackDefault;
  } else {
    session.lastFolder = lastFolder;
    const lastFile = firstOf(stored.lastFile, stored.file);
    if (lastFile !== undefined) session.lastFile = lastFile;
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
  const themeSelect = d.getElementById("settings-theme");
  if (themeSelect && typeof themeSelect.addEventListener === "function") {
    themeSelect.addEventListener("change", () => {
      persistSession({ theme: themeSelect.value });
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

// Fake Tauri backend for tests. It mirrors src-tauri/src/lib.rs and the plugin
// commands behind window.__TAURI__, so app bugs can't hide behind it:
// - unknown commands reject with "Command <name> not found", like Tauri;
// - files live in one in-memory filesystem keyed by absolute path, so every
//   command honours args.path (a write under another root lands there);
// - confinement follows confined_path(), errors are plain strings like Rust's
//   io::Error strings, and args are JSON round-tripped and checked like
//   Tauri's argument parsing;
// - plugin commands are gated by src-tauri/capabilities like Tauri's ACL.
//
// Node tests reach it through bootApp() (tests/helpers/app.mjs). The e2e
// harness (tests/e2e/helpers/app.mjs) runs it in Node and bridges the page to
// it, with buildTauriGlobals() providing the same window.__TAURI__ shape.
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { root as repoRoot } from "./source.mjs";

// Every command the real app can reach. Add a command here when you register
// it in Rust (generate_handler! in src-tauri/src/lib.rs) or start calling a
// new plugin command, then add its fake to `handlers` below.
// tests/tauri-contract.test.mjs checks this list against lib.rs and src/.
export const KNOWN_COMMANDS = [
  "list_workspace",
  "read_workspace_file",
  "write_workspace_file",
  "stat_workspace_file",
  "read_workspace_image",
  "create_workspace_folder",
  "workspace_file_exists",
  "plugin:dialog|open",
  "plugin:dialog|save",
  "plugin:dialog|message", // dialog.ask() and dialog.confirm() use it
  "plugin:opener|open_url",
  "plugin:window|set_size",
  "plugin:window|destroy", // onCloseRequested() destroys the window unless prevented
  "plugin:event|listen", // window.listen() / onCloseRequested()
  "plugin:event|unlisten",
];

export const OUTSIDE = "path is outside workspace root";
const ENOENT = "No such file or directory (os error 2)";
const ENOTDIR = "Not a directory (os error 20)";
const EISDIR = "Is a directory (os error 21)";
const EEXIST = "File exists (os error 17)";
const EUTF8 = "stream did not contain valid UTF-8";
const ENOTFILE = "path is not a file";
const CONFLICT = "conflict: file changed on disk";

// Argument types per command, as Tauri deserializes them ("?" = Option<_>).
const COMMAND_ARGS = {
  list_workspace: { path: "string", sort: "string?" },
  read_workspace_file: { path: "string", relative: "string" },
  write_workspace_file: {
    path: "string",
    relative: "string",
    contents: "string",
    expectedModifiedMs: "u64?",
  },
  stat_workspace_file: { path: "string", relative: "string" },
  read_workspace_image: { path: "string", relative: "string" },
  create_workspace_folder: { path: "string", relative: "string" },
  workspace_file_exists: { path: "string", relative: "string" },
  "plugin:dialog|message": { message: "string" },
  "plugin:opener|open_url": { url: "string", with: "string?" },
};

// Commands granted by each plugin's `default` permission set.
const PLUGIN_DEFAULTS = {
  dialog: ["open", "save", "message"],
  opener: ["open_url", "reveal_item_in_dir"],
  window: ["inner_size", "outer_size", "scale_factor", "title", "theme", "is_visible"],
  event: ["listen", "unlisten", "emit", "emit_to"],
};
const CORE_PLUGINS = new Set(["window", "webview", "app", "event", "path", "menu", "tray"]);

export function normalizeRel(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

export function isEscapingRelative(relative) {
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

// Permissions granted to the main window by src-tauri/capabilities/*.json.
export function loadCapabilities(dir = join(repoRoot, "src-tauri", "capabilities")) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const cap = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const windows = cap.windows || [];
    if (windows.length && !windows.includes("main") && !windows.includes("*")) continue;
    for (const p of cap.permissions || []) out.push(typeof p === "string" ? p : p.identifier);
  }
  return out;
}

function allowedByAcl(cmd, permissions) {
  const m = /^plugin:([^|]+)\|(.+)$/.exec(cmd);
  if (!m) return true; // app commands: no app ACL manifest, so not gated
  const [, plugin, command] = m;
  const prefix = CORE_PLUGINS.has(plugin) ? `core:${plugin}` : plugin;
  const ids = new Set(permissions);
  const kebab = command.replace(/_/g, "-");
  if (ids.has(`${prefix}:deny-${kebab}`)) return false;
  if (ids.has(`${prefix}:allow-${kebab}`)) return true;
  const viaDefault =
    ids.has(`${prefix}:default`) || (CORE_PLUGINS.has(plugin) && ids.has("core:default"));
  return viaDefault && (PLUGIN_DEFAULTS[plugin] || []).includes(command);
}

function describeJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") {
    return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  }
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return "sequence";
  return "map";
}

function checkArgs(cmd, args) {
  const spec = COMMAND_ARGS[cmd];
  if (!spec) return;
  const name = cmd.includes("|") ? cmd.split("|")[1] : cmd;
  for (const [key, type] of Object.entries(spec)) {
    const optional = type.endsWith("?");
    const value = args[key];
    if (value === undefined || (optional && value === null)) {
      if (optional) continue;
      throw `invalid args \`${key}\` for command \`${name}\`: command ${name} missing required key ${key}`;
    }
    const base = optional ? type.slice(0, -1) : type;
    if (base === "u64") {
      if (!Number.isInteger(value) || value < 0) {
        throw `invalid args \`${key}\` for command \`${name}\`: invalid type: ${describeJson(value)}, expected u64`;
      }
      continue;
    }
    if (typeof value !== "string") {
      throw `invalid args \`${key}\` for command \`${name}\`: invalid type: ${describeJson(value)}, expected a string`;
    }
  }
}

// What crosses Tauri's IPC is JSON: undefined keys vanish, bytes become arrays.
// A raw tauri::ipc::Response (read_workspace_image) arrives as an ArrayBuffer.
function toIpc(value) {
  if (value === undefined) return null;
  if (value instanceof ArrayBuffer) return value.slice(0);
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)),
  );
}

function normalizeAbs(path) {
  const p = posix.normalize(String(path));
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function joinAbs(root, rel) {
  return rel ? (root === "/" ? `/${rel}` : `${root}/${rel}`) : root;
}

function seedEntries(files) {
  if (!files) return [];
  if (files instanceof Map || Array.isArray(files)) return [...files];
  return Object.entries(files);
}

function extensionOf(relative) {
  const base = relative.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function utf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

/**
 * createInvoke(options) -> backend
 *
 * options:
 *   root          default workspace folder (absolute), default "/tmp/lightmd-ws"
 *   files         { relative: contents } (object, Map or entries) under `root`;
 *                 contents is a string, { bytes: [...] } or { is_dir: true }
 *   folders       extra empty folders under `root`
 *   workspaces    { "/abs/folder": { files, folders } } more folders on "disk"
 *   dialog        answers: { open, save, confirm }; each a value or a function
 *                 (options | message) => value. open defaults to `root`, save to
 *                 null (cancelled), confirm to false. A path a dialog returns
 *                 exists on disk afterwards, like a real picker.
 *   capabilities  permission ids gating plugin:* commands; default: the repo's
 *                 src-tauri/capabilities. Pass null to disable the ACL check.
 *   onInvoke      async (cmd, args, backend) => value | undefined; runs after
 *                 the known-command and argument checks; return undefined to
 *                 fall through to the fake, a value to override, or throw a
 *                 string to reject.
 *
 * backend: { invoke, invokes, rejections, writes, attemptedWrites, dialogs,
 *   confirms, opened, windowCalls, listeners, dialog, files, folders, root,
 *   read, write, mkdir, isFile, isDir, mtime, snapshot }
 *
 * Every write (the app's, or a test's files.set()/write() standing in for
 * another program) bumps the file's mtime, so expectedModifiedMs conflicts
 * behave like Rust's write_file_if_unchanged().
 */
export function createInvoke({
  root = "/tmp/lightmd-ws",
  files = {},
  folders = [],
  workspaces = {},
  dialog = {},
  capabilities = loadCapabilities(),
  onInvoke = null,
} = {}) {
  const rootAbs = normalizeAbs(root);
  // abs -> { type: "file", data, mtime } | { type: "dir", mtime }. mtime is a
  // counter that every write bumps; stat_workspace_file reports it as modified_ms.
  const entries = new Map();
  let clock = 0;
  let listenerIds = 0;

  function entry(abs) {
    if (abs === "/") return { type: "dir", mtime: 0 };
    return entries.get(abs);
  }

  // Walks abs's ancestors like the kernel: a file in the way is ENOTDIR.
  function lookup(abs) {
    const parts = abs.split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      cur += `/${parts[i]}`;
      const e = entry(cur);
      if (!e) return { error: ENOENT };
      if (i < parts.length - 1 && e.type !== "dir") return { error: ENOTDIR };
    }
    return { entry: entry(abs) };
  }

  function mkdirp(abs) {
    let cur = "";
    for (const part of abs.split("/").filter(Boolean)) {
      cur += `/${part}`;
      const e = entries.get(cur);
      if (e && e.type !== "dir") throw ENOTDIR;
      if (!e) entries.set(cur, { type: "dir", mtime: ++clock });
    }
  }

  function putFile(abs, value) {
    const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
    mkdirp(parent);
    const e = entries.get(abs);
    if (e && e.type === "dir") throw EISDIR;
    entries.set(abs, { type: "file", data: value, mtime: ++clock });
  }

  function seed(base, spec = {}) {
    const dir = normalizeAbs(base);
    mkdirp(dir);
    for (const [rel, value] of seedEntries(spec.files)) {
      const abs = joinAbs(dir, normalizeRel(rel).replace(/^\/+/, ""));
      if (value && typeof value === "object" && value.is_dir) mkdirp(abs);
      else if (value && typeof value === "object" && "bytes" in value) {
        putFile(abs, { bytes: Array.from(value.bytes) });
      } else if (value && typeof value === "object" && typeof value.contents === "string") {
        putFile(abs, value.contents);
      } else putFile(abs, value == null ? "" : String(value));
    }
    for (const f of spec.folders || []) mkdirp(joinAbs(dir, normalizeRel(f)));
  }

  seed(rootAbs, { files, folders });
  for (const [dir, spec] of Object.entries(workspaces || {})) seed(dir, spec || {});

  // Path::canonicalize(root): the folder must exist.
  function resolveRoot(path) {
    const p = normalizeAbs(path);
    if (!p.startsWith("/")) throw ENOENT;
    const found = lookup(p);
    if (found.error) throw found.error;
    if (found.entry.type !== "dir") throw ENOTDIR;
    return p;
  }

  // confined_path(): reject absolute paths and `..` above the root.
  // Mirrors unix Rust: only a leading "/" is absolute and "\" is an ordinary char.
  function confine(path, relative) {
    const base = resolveRoot(path);
    const rel = String(relative);
    if (rel.startsWith("/")) throw OUTSIDE;
    const parts = [];
    for (const part of rel.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) throw OUTSIDE;
        parts.pop();
        continue;
      }
      parts.push(part);
    }
    return { base, rel: parts.join("/"), abs: joinAbs(base, parts.join("/")) };
  }

  function readText(abs) {
    const found = lookup(abs);
    if (found.error) throw found.error;
    if (found.entry.type === "dir") throw EISDIR;
    const data = found.entry.data;
    if (typeof data === "string") return data;
    try {
      return utf8(data.bytes);
    } catch {
      throw EUTF8;
    }
  }

  const backend = {
    root: rootAbs,
    invokes: [],
    rejections: [],
    writes: [],
    attemptedWrites: [],
    dialogs: [],
    confirms: [],
    opened: [],
    windowCalls: [],
    listeners: [], // { id, event, target, handler } from plugin:event|listen
    dialog: {
      open: dialog.open !== undefined ? dialog.open : rootAbs,
      save: dialog.save !== undefined ? dialog.save : null,
      confirm: dialog.confirm !== undefined ? dialog.confirm : false,
    },
  };

  async function answer(value, ...args) {
    return typeof value === "function" ? await value(...args) : value;
  }

  function ensurePicked(picked, directory) {
    for (const p of Array.isArray(picked) ? picked : [picked]) {
      if (typeof p !== "string" || !p.startsWith("/")) continue;
      const abs = normalizeAbs(p);
      mkdirp(directory ? abs : abs.slice(0, abs.lastIndexOf("/")) || "/");
    }
  }

  function buttonLabels(buttons) {
    if (buttons === "YesNo" || buttons === "YesNoCancel") return ["Yes", "No"];
    if (buttons === "OkCancel") return ["Ok", "Cancel"];
    if (buttons && Array.isArray(buttons.OkCancelCustom)) return buttons.OkCancelCustom;
    if (buttons && Array.isArray(buttons.YesNoCancelCustom)) return buttons.YesNoCancelCustom;
    if (buttons && typeof buttons.OkCustom === "string") return [buttons.OkCustom, buttons.OkCustom];
    return ["Ok", "Ok"];
  }

  const handlers = {
    list_workspace({ path, sort }) {
      const base = resolveRoot(path);
      const prefix = base === "/" ? "/" : `${base}/`;
      const out = [];
      for (const [abs, e] of entries) {
        if (!abs.startsWith(prefix)) continue;
        const relative_path = abs.slice(prefix.length);
        if (e.type === "dir") out.push({ relative_path, is_dir: true, mtime: e.mtime });
        else if (["md", "html", "htm"].includes(extensionOf(relative_path))) {
          out.push({ relative_path, is_dir: false, mtime: e.mtime });
        }
      }
      const byName = (a, b) => {
        const x = asciiLower(a.relative_path);
        const y = asciiLower(b.relative_path);
        return x < y ? -1 : x > y ? 1 : 0;
      };
      out.sort(sort === "modified" ? (a, b) => b.mtime - a.mtime || byName(a, b) : byName);
      return out.map(({ relative_path, is_dir }) => ({ relative_path, is_dir }));
    },
    read_workspace_file({ path, relative }) {
      return readText(confine(path, relative).abs);
    },
    // Returns the new modified_ms. With expectedModifiedMs, an existing file
    // whose mtime differs is left alone and the write rejects "conflict: …".
    write_workspace_file(args) {
      const record = {
        cmd: "write_workspace_file",
        path: args.path,
        relative: args.relative,
        contents: args.contents,
      };
      if (args.expectedModifiedMs != null) record.expectedModifiedMs = args.expectedModifiedMs;
      backend.attemptedWrites.push(record);
      const { abs } = confine(args.path, args.relative);
      if (args.expectedModifiedMs != null) {
        const found = lookup(abs);
        if (found.entry && found.entry.mtime !== args.expectedModifiedMs) throw CONFLICT;
        if (found.error && found.error !== ENOENT) throw found.error;
      }
      putFile(abs, args.contents);
      backend.writes.push({ ...record, abs });
      return entries.get(abs).mtime;
    },
    stat_workspace_file({ path, relative }) {
      const found = lookup(confine(path, relative).abs);
      if (found.error) throw found.error;
      if (found.entry.type !== "file") throw ENOTFILE;
      const data = found.entry.data;
      const size =
        typeof data === "string" ? new TextEncoder().encode(data).length : data.bytes.length;
      return { modified_ms: found.entry.mtime, size };
    },
    create_workspace_folder({ path, relative }) {
      const { abs } = confine(path, relative);
      const found = lookup(abs);
      if (found.entry && found.entry.type !== "dir") throw EEXIST;
      if (found.error === ENOTDIR) throw ENOTDIR;
      mkdirp(abs);
      return null;
    },
    read_workspace_image({ path, relative }) {
      const found = lookup(confine(path, relative).abs);
      if (found.error) throw found.error;
      if (found.entry.type === "dir") throw EISDIR;
      const data = found.entry.data;
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data.bytes);
      return bytes.buffer;
    },
    workspace_file_exists({ path, relative }) {
      const found = lookup(confine(path, relative).abs);
      return Boolean(found.entry && found.entry.type === "file");
    },
    async "plugin:dialog|open"(args) {
      const options = args.options || {};
      const picked = await answer(backend.dialog.open, options);
      backend.dialogs.push({ kind: "open", options, answer: picked ?? null });
      ensurePicked(picked, !!options.directory);
      return picked ?? null;
    },
    async "plugin:dialog|save"(args) {
      const options = args.options || {};
      const picked = await answer(backend.dialog.save, options);
      backend.dialogs.push({ kind: "save", options, answer: picked ?? null });
      ensurePicked(picked, false);
      return picked ?? null;
    },
    async "plugin:dialog|message"(args) {
      backend.confirms.push(args.message);
      const [ok, cancel] = buttonLabels(args.buttons);
      const said = await answer(backend.dialog.confirm, args.message, args);
      const label = typeof said === "string" ? said : said ? ok : cancel;
      backend.dialogs.push({
        kind: "message",
        message: args.message,
        title: args.title,
        buttons: args.buttons,
        answer: label,
      });
      return label;
    },
    "plugin:opener|open_url"({ url }) {
      backend.opened.push(url);
      return null;
    },
    "plugin:window|set_size"(args) {
      backend.windowCalls.push({ cmd: "set_size", args });
      return null;
    },
    "plugin:window|destroy"(args) {
      backend.windowCalls.push({ cmd: "destroy", args });
      return null;
    },
    "plugin:event|listen"({ event, target, handler }) {
      const id = ++listenerIds;
      backend.listeners.push({ id, event, target, handler });
      return id;
    },
    "plugin:event|unlisten"({ eventId }) {
      backend.listeners = backend.listeners.filter((l) => l.id !== eventId);
      return null;
    },
  };

  async function invoke(cmd, rawArgs = {}) {
    const name = String(cmd);
    const args = toIpc(rawArgs ?? {}) || {};
    backend.invokes.push({ cmd: name, args });
    try {
      if (!KNOWN_COMMANDS.includes(name) || !handlers[name]) {
        throw `Command ${name.includes("|") ? name.split("|")[1] : name} not found`;
      }
      if (Array.isArray(capabilities) && !allowedByAcl(name, capabilities)) {
        throw `Command ${name} not allowed by ACL`;
      }
      checkArgs(name, args);
      if (typeof onInvoke === "function") {
        const override = await onInvoke(name, args, backend);
        if (override !== undefined) return toIpc(override);
      }
      return toIpc(await handlers[name](args));
    } catch (err) {
      backend.rejections.push({ cmd: name, args, error: err });
      throw err;
    }
  }

  function filesUnder(base) {
    const prefix = base === "/" ? "/" : `${base}/`;
    return [...entries]
      .filter(([abs, e]) => e.type === "file" && abs.startsWith(prefix))
      .map(([abs, e]) => [abs.slice(prefix.length), e.data])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // A live Map-like view of the files under `root`, keyed by relative path.
  const view = {
    get(rel) {
      const e = entry(joinAbs(rootAbs, normalizeRel(rel)));
      return e && e.type === "file" ? e.data : undefined;
    },
    set(rel, value) {
      putFile(joinAbs(rootAbs, normalizeRel(rel)), value);
      return view;
    },
    has(rel) {
      return view.get(rel) !== undefined;
    },
    delete(rel) {
      return entries.delete(joinAbs(rootAbs, normalizeRel(rel)));
    },
    keys() {
      return filesUnder(rootAbs).map(([k]) => k)[Symbol.iterator]();
    },
    values() {
      return filesUnder(rootAbs).map(([, v]) => v)[Symbol.iterator]();
    },
    entries() {
      return filesUnder(rootAbs)[Symbol.iterator]();
    },
    forEach(fn) {
      for (const [k, v] of filesUnder(rootAbs)) fn(v, k, view);
    },
    get size() {
      return filesUnder(rootAbs).length;
    },
    [Symbol.iterator]() {
      return view.entries();
    },
  };

  Object.defineProperty(backend, "folders", {
    enumerable: true,
    get() {
      const prefix = rootAbs === "/" ? "/" : `${rootAbs}/`;
      return [...entries]
        .filter(([abs, e]) => e.type === "dir" && abs.startsWith(prefix))
        .map(([abs]) => abs.slice(prefix.length))
        .sort();
    },
  });

  return Object.assign(backend, {
    invoke,
    files: view,
    read(base, rel = "") {
      const e = entry(joinAbs(normalizeAbs(base), normalizeRel(rel)));
      return e && e.type === "file" ? e.data : undefined;
    },
    write(base, rel, value) {
      putFile(joinAbs(normalizeAbs(base), normalizeRel(rel)), value);
    },
    mkdir(base, rel = "") {
      mkdirp(joinAbs(normalizeAbs(base), normalizeRel(rel)));
    },
    isFile(base, rel = "") {
      return entry(joinAbs(normalizeAbs(base), normalizeRel(rel)))?.type === "file";
    },
    isDir(base, rel = "") {
      return entry(joinAbs(normalizeAbs(base), normalizeRel(rel)))?.type === "dir";
    },
    mtime(base, rel = "") {
      return entry(joinAbs(normalizeAbs(base), normalizeRel(rel)))?.mtime;
    },
    snapshot() {
      return Object.fromEntries(filesUnder("/").map(([k, v]) => [`/${k}`, v]));
    },
  });
}

// Builds window.__TAURI__ and window.__TAURI_INTERNALS__ the way Tauri's global
// API does (app.withGlobalTauri): core.invoke plus the dialog, opener and
// window plugin APIs, all of which go through ipc(cmd, args).
// Event listeners register a callback id with plugin:event|listen, like Tauri;
// __TAURI_INTERNALS__.runCallback(id, event) delivers an event to one and
// returns what the listener returns, so a test can await it.
// It must stay self-contained (no outer references): the e2e harness puts its
// source text into the page.
export function buildTauriGlobals(ipc, { label = "main" } = {}) {
  const invoke = (cmd, args = {}, options) => ipc(cmd, args, options);
  const callbacks = new Map();
  let nextCallback = 1;
  function transformCallback(callback, once = false) {
    const id = nextCallback++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return callback && callback(data);
    });
    return id;
  }
  function runCallback(id, data) {
    const callback = callbacks.get(id);
    return callback ? callback(data) : undefined;
  }
  class LogicalSize {
    constructor(width, height) {
      this.type = "Logical";
      this.width = width;
      this.height = height;
    }
  }
  class PhysicalSize {
    constructor(width, height) {
      this.type = "Physical";
      this.width = width;
      this.height = height;
    }
  }
  class LogicalPosition {
    constructor(x, y) {
      this.type = "Logical";
      this.x = x;
      this.y = y;
    }
  }
  class PhysicalPosition {
    constructor(x, y) {
      this.type = "Physical";
      this.x = x;
      this.y = y;
    }
  }
  const sizeValue = (size) => ({ [size.type]: { width: size.width, height: size.height } });
  // Tauri's CloseRequestedEvent.
  class CloseRequestedEvent {
    constructor(event) {
      this.event = event.event;
      this.id = event.id;
      this._preventDefault = false;
    }
    preventDefault() {
      this._preventDefault = true;
    }
    isPreventDefault() {
      return this._preventDefault;
    }
  }
  const currentWindow = {
    label,
    setSize: (size) => invoke("plugin:window|set_size", { label, value: sizeValue(size) }),
    destroy: () => invoke("plugin:window|destroy", { label }),
    async listen(event, handler) {
      const eventId = await invoke("plugin:event|listen", {
        event,
        target: { kind: "Window", label },
        handler: transformCallback(handler),
      });
      return () => invoke("plugin:event|unlisten", { event, eventId });
    },
    // Like Tauri: while a listener exists the close waits for it, then the
    // window is destroyed unless the listener called event.preventDefault().
    onCloseRequested(handler) {
      return currentWindow.listen("tauri://close-requested", async (event) => {
        const evt = new CloseRequestedEvent(event);
        await handler(evt);
        if (!evt.isPreventDefault()) await currentWindow.destroy();
      });
    },
  };
  function buttonsArg(buttons) {
    if (buttons === undefined || typeof buttons === "string") return buttons;
    if ("ok" in buttons && "cancel" in buttons) return { OkCancelCustom: [buttons.ok, buttons.cancel] };
    if ("yes" in buttons && "no" in buttons && "cancel" in buttons) {
      return { YesNoCancelCustom: [buttons.yes, buttons.no, buttons.cancel] };
    }
    if ("ok" in buttons) return { OkCustom: buttons.ok };
    return undefined;
  }
  function message(text, options) {
    const o = typeof options === "string" ? { title: options } : options;
    return invoke("plugin:dialog|message", {
      message: text,
      title: o?.title,
      kind: o?.kind,
      buttons: buttonsArg(o?.buttons),
    });
  }
  function choice(text, options, okDefault, cancelDefault, preset) {
    const o = typeof options === "string" ? { title: options } : options;
    const custom = o?.okLabel || o?.cancelLabel;
    const ok = o?.okLabel ?? okDefault;
    const buttons = custom ? { ok, cancel: o.cancelLabel ?? cancelDefault } : preset;
    return message(text, { title: o?.title, kind: o?.kind, buttons }).then((said) => said === ok);
  }
  const core = {
    invoke,
    isTauri: () => true,
    convertFileSrc(filePath, protocol = "asset") {
      return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
    },
  };
  const dialog = {
    open: (options = {}) => invoke("plugin:dialog|open", { options }),
    save: (options = {}) => invoke("plugin:dialog|save", { options }),
    message,
    ask: (text, options) => choice(text, options, "Yes", "No", "YesNo"),
    confirm: (text, options) => choice(text, options, "Ok", "Cancel", "OkCancel"),
  };
  const opener = {
    openUrl: async (url, openWith) => {
      await invoke("plugin:opener|open_url", { url, with: openWith });
    },
    openPath: async (path, openWith) => {
      await invoke("plugin:opener|open_path", { path, with: openWith });
    },
    revealItemInDir: (path) =>
      invoke("plugin:opener|reveal_item_in_dir", { paths: typeof path === "string" ? [path] : path }),
  };
  const dpi = { LogicalSize, PhysicalSize, LogicalPosition, PhysicalPosition };
  return {
    __TAURI_INTERNALS__: {
      invoke,
      transformCallback,
      runCallback,
      convertFileSrc: core.convertFileSrc,
      metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
    },
    __TAURI__: {
      core,
      dialog,
      opener,
      dpi,
      window: { getCurrentWindow: () => currentWindow, ...dpi },
      webviewWindow: { getCurrentWebviewWindow: () => currentWindow, ...dpi },
    },
  };
}

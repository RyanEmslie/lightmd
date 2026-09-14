import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, test } from "node:test";
import { loadSourceText } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const WRITE_CMD = "write_workspace_file";
const WRITE_ERR = "disk full: write_workspace_file failed";

installStubGlobals();

const { autosave, cancelAutosave, scheduleAutoSave } = await import(
  pathToFileURL(join(srcDir, "autosave.js")).href
);

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

function loadSources() {
  return loadSourceText();
}

function autosaveSource() {
  const p = join(srcDir, "autosave.js");
  assert.equal(existsSync(p), true, "src/autosave.js must exist");
  return readFileSync(p, "utf8");
}

function handlesWriteRejection(src) {
  if (!src || !new RegExp(WRITE_CMD).test(src)) return false;
  if (
    /try\s*\{[\s\S]{0,2000}?invoke\(\s*["']write_workspace_file["'][\s\S]{0,1500}?\}\s*catch\b/.test(
      src,
    )
  ) {
    return true;
  }
  if (/invoke\(\s*["']write_workspace_file["'][\s\S]{0,600}?\.catch\s*\(/.test(src)) {
    return true;
  }
  if (
    /\b(?:scheduleAutoSave|setTimeout)\s*\([\s\S]{0,2500}?\.catch\s*\(/.test(src)
  ) {
    return true;
  }
  return false;
}

function catchClearsDirty(src) {
  return (
    /catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,500}?setDirty\(\s*false\s*\)/.test(src) ||
    /\.catch\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?:=>)?\s*\{[\s\S]{0,500}?setDirty\(\s*false\s*\)/.test(
      src,
    )
  );
}

function writeFailureLeavesDirty(src) {
  if (!handlesWriteRejection(src)) return false;
  return !catchClearsDirty(src);
}

function looksLikeStatusSignalPath(src) {
  if (!src) return false;
  return (
    /getElementById\(\s*["'](?:status[-_]?(?:strip|path|error|message|text)|save[-_]?error|autosave[-_]?error)["']/i.test(
      src,
    ) ||
    /querySelector(?:All)?\(\s*["'][^"']*(?:status[-_]?(?:strip|path|error)|save[-_]?error|autosave[-_]?error|aria-live|role=["']?(?:alert|status))[^"']*["']/i.test(
      src,
    ) ||
    /dataset\.\w*(?:error|fail|status)|setAttribute\(\s*["'](?:data-(?:save-)?error|aria-live|aria-invalid)/i.test(
      src,
    ) ||
    /lightmd(?:Set)?(?:Status|SaveError|Error|SaveStatus)/i.test(src) ||
    /#(?:status-strip|status-path|status-error|save-error|autosave-error)\b/i.test(
      src,
    )
  );
}

function hasFailureSignalPath(src) {
  if (!handlesWriteRejection(src)) return false;
  const auto = existsSync(join(srcDir, "autosave.js")) ? autosaveSource() : src;
  return looksLikeStatusSignalPath(auto) || looksLikeStatusSignalPath(src);
}

function mockEl(id, tag = "div") {
  const el = {
    id,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    hidden: false,
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
    setAttribute(name, value) {
      const key = String(name);
      const val = String(value);
      el.attributes[key] = val;
      if (key === "id") el.id = val;
      if (key === "hidden") el.hidden = true;
      if (key === "role") el.role = val;
      if (key.startsWith("data-")) {
        const dk = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[dk] = val;
      }
      if (key.startsWith("aria-")) {
        el.attributes[key] = val;
      }
    },
    getAttribute(name) {
      const key = String(name);
      return Object.prototype.hasOwnProperty.call(el.attributes, key)
        ? el.attributes[key]
        : null;
    },
    removeAttribute(name) {
      delete el.attributes[name];
      if (name === "hidden") el.hidden = false;
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    append(...nodes) {
      for (const n of nodes) el.appendChild(n);
    },
    querySelector(sel) {
      return findIn(el, sel);
    },
    querySelectorAll(sel) {
      const out = [];
      collectMatches(el, sel, out);
      return out;
    },
  };
  return el;
}

function selectorMatch(node, sel) {
  const s = String(sel || "").trim();
  if (!s) return false;
  if (s.startsWith("#")) return node.id === s.slice(1);
  const data = s.match(/^\[data-([a-z0-9-]+)(?:=["']?([^"'\]]+)["']?)?\]$/i);
  if (data) {
    const key = data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const got = node.dataset?.[key];
    if (got == null || got === "") return false;
    return data[2] == null ? true : String(got) === data[2];
  }
  const aria = s.match(/^\[aria-([a-z0-9-]+)(?:=["']?([^"'\]]+)["']?)?\]$/i);
  if (aria) {
    const key = `aria-${aria[1]}`;
    const got = node.getAttribute?.(key) ?? node.attributes?.[key];
    if (got == null || got === "") return false;
    return aria[2] == null ? true : String(got) === aria[2];
  }
  const role = s.match(/^\[role=["']?([^"'\]]+)["']?\]$/i);
  if (role) {
    return String(node.getAttribute?.("role") ?? node.role ?? "") === role[1];
  }
  return false;
}

function findIn(root, sel) {
  if (selectorMatch(root, sel)) return root;
  for (const child of root.children || []) {
    const hit = findIn(child, sel);
    if (hit) return hit;
  }
  return null;
}

function collectMatches(root, sel, out) {
  if (selectorMatch(root, sel)) out.push(root);
  for (const child of root.children || []) collectMatches(child, sel, out);
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
    fire({ swallow } = {}) {
      const jobs = [...pending.values()];
      pending.clear();
      const running = [];
      for (const job of jobs) {
        let result;
        try {
          result = job.fn(...job.args);
        } catch (err) {
          if (!swallow) throw err;
        }
        if (result && typeof result.then === "function") {
          running.push(swallow ? result.then(() => {}, () => {}) : result);
        }
      }
      return running;
    },
    restore() {
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
      pending.clear();
    },
  };
}

function visibleStatusSignal(run) {
  const nodes = [];
  const walk = (n) => {
    if (!n || nodes.includes(n)) return;
    nodes.push(n);
    for (const c of n.children || []) walk(c);
  };
  for (const n of run.byId.values()) walk(n);
  for (const n of run.created || []) walk(n);
  walk(run.doc?.body);
  walk(run.doc?.documentElement);

  for (const el of nodes) {
    if (!el || el.id === "dirty") continue;
    const text = String(el.textContent || el.innerHTML || "");
    if (
      /fail|error|couldn['’]?t save|unable to save|not saved|save (?:failed|error)/i.test(
        text,
      )
    ) {
      return true;
    }
    const ds = el.dataset || {};
    for (const [k, v] of Object.entries(ds)) {
      if (
        /error|fail|status/i.test(k) &&
        v != null &&
        String(v) !== "" &&
        String(v) !== "false" &&
        String(v) !== "0"
      ) {
        return true;
      }
    }
    const attrs = el.attributes || {};
    for (const [k, v] of Object.entries(attrs)) {
      if (
        /^(?:data-(?:save-)?error|data-status|aria-invalid)$/i.test(k) &&
        v != null &&
        String(v) !== "" &&
        String(v) !== "false"
      ) {
        return true;
      }
    }
    const role = el.getAttribute?.("role") ?? el.role;
    if (
      (role === "alert" || role === "status") &&
      /fail|error|save/i.test(text)
    ) {
      return true;
    }
    const live = el.getAttribute?.("aria-live") ?? el.attributes?.["aria-live"];
    if (live && /fail|error|save/i.test(text)) return true;
  }
  return false;
}

async function runRejectedAutosave({ swallow = true } = {}) {
  const timers = installFakeTimers();
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTauri = globalThis.__TAURI__;
  const prevWs = globalThis.lightmdWorkspace;
  const prevSetDirty = globalThis.lightmdSetDirty;
  const prevEnabled = autosave.enabled;
  const prevDelay = autosave.delay;

  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  const byId = new Map();
  const el = (id, tag = "div") => {
    const key = String(id);
    if (!byId.has(key)) byId.set(key, mockEl(key, tag));
    return byId.get(key);
  };

  const strip = el("status-strip", "footer");
  const path = el("status-path", "span");
  const dirtyDot = el("dirty", "span");
  const words = el("word-count", "span");
  path.textContent = "note.md";
  dirtyDot.hidden = false;
  strip.appendChild(path);
  strip.appendChild(dirtyDot);
  strip.appendChild(words);

  const created = [];
  const doc = {
    documentElement: mockEl("html", "html"),
    body: mockEl("body", "body"),
    getElementById(id) {
      return byId.has(String(id)) ? byId.get(String(id)) : null;
    },
    querySelector(sel) {
      const m = String(sel || "").match(/^#([\w-]+)$/);
      if (m) return doc.getElementById(m[1]);
      return findIn(strip, sel) || findIn(doc.body, sel) || findIn(doc.documentElement, sel);
    },
    querySelectorAll(sel) {
      const out = [];
      collectMatches(strip, sel, out);
      collectMatches(doc.body, sel, out);
      collectMatches(doc.documentElement, sel, out);
      return out;
    },
    createElement(tag) {
      const node = mockEl("", tag);
      created.push(node);
      return node;
    },
  };
  doc.body.appendChild(strip);

  const dirtyCalls = [];
  let dirty = true;
  const invokes = [];

  const win = globalThis;
  win.document = doc;
  globalThis.document = doc;
  globalThis.window = win;
  win.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        invokes.push({ cmd, args });
        if (cmd === WRITE_CMD) {
          throw new Error(WRITE_ERR);
        }
        return null;
      },
    },
  };
  globalThis.__TAURI__ = win.__TAURI__;
  win.lightmdWorkspace = {
    path: "/tmp/lightmd-workspace",
    relative: "note.md",
    contents: "# dirty buffer\n",
  };
  win.lightmdSetDirty = (value) => {
    dirtyCalls.push(value);
    dirty = Boolean(value);
    dirtyDot.hidden = !dirty;
  };

  autosave.enabled = true;
  autosave.delay = 1;
  cancelAutosave();
  scheduleAutoSave();

  try {
    const running = timers.fire({ swallow });
    if (swallow) {
      await Promise.all(running);
    } else {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setImmediate(r));
    return {
      dirty,
      dirtyCalls,
      unhandled: unhandled.slice(),
      invokes,
      el,
      byId,
      created,
      doc,
      win,
    };
  } finally {
    process.off("unhandledRejection", onUnhandled);
    timers.restore();
    cancelAutosave();
    autosave.enabled = prevEnabled;
    autosave.delay = prevDelay;
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    if (prevTauri === undefined) delete globalThis.__TAURI__;
    else globalThis.__TAURI__ = prevTauri;
    if (prevWs === undefined) delete globalThis.lightmdWorkspace;
    else globalThis.lightmdWorkspace = prevWs;
    if (prevSetDirty === undefined) delete globalThis.lightmdSetDirty;
    else globalThis.lightmdSetDirty = prevSetDirty;
  }
}

describe("autosave write errors", { concurrency: false }, () => {
  test("scheduleAutoSave write rejection is caught (no unhandled rejection)", async () => {
    const src = loadSources();
    const run = await runRejectedAutosave({ swallow: true });
    assert.ok(
      run.invokes.some((c) => c.cmd === WRITE_CMD),
      "precondition: scheduleAutoSave must invoke write_workspace_file",
    );
    assert.equal(
      run.unhandled.length,
      0,
      "write_workspace_file rejection during scheduleAutoSave must not leave an unhandled rejection",
    );
    assert.ok(
      handlesWriteRejection(src),
      "scheduleAutoSave must catch/handle write_workspace_file rejection (try/catch or .catch)",
    );
  });

  test("after autosave write failure, dirty remains true (setDirty(false) is not called)", async () => {
    const src = loadSources();
    const run = await runRejectedAutosave({ swallow: true });
    assert.ok(
      run.invokes.some((c) => c.cmd === WRITE_CMD),
      "precondition: scheduleAutoSave must invoke write_workspace_file",
    );
    assert.equal(
      run.dirty,
      true,
      "after a failed autosave write, dirty must remain true",
    );
    assert.ok(
      !run.dirtyCalls.includes(false),
      "setDirty(false) must not be called when write_workspace_file rejects",
    );
    assert.ok(
      writeFailureLeavesDirty(src),
      "autosave write failure must be caught/handled without calling setDirty(false)",
    );
  });

  test("after autosave write failure, a user-visible status signal exists", async () => {
    const src = loadSources();
    const run = await runRejectedAutosave({ swallow: true });
    assert.ok(
      run.invokes.some((c) => c.cmd === WRITE_CMD),
      "precondition: scheduleAutoSave must invoke write_workspace_file",
    );
    assert.ok(
      visibleStatusSignal(run) || hasFailureSignalPath(src),
      "after autosave write failure, a minimal user-visible status signal must exist (status strip text / data attribute / aria / dedicated status node)",
    );
  });
});

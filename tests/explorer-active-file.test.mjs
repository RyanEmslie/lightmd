import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "index.html");

const FOLDER = "/tmp/lightmd-explorer-active";
const FILE_A = "a.md";
const FILE_B = "b.md";
const DIR_NOTES = "notes";
const FILE_NESTED = "notes/nested.md";

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

function styleCss(html) {
  const chunks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) chunks.push(m[1]);
  return chunks.join("\n");
}

function stripComments(css) {
  return String(css || "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseRules(css) {
  const cleaned = stripComments(css);
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const selector = m[1].replace(/@[\w-]+[^{]*/g, "").trim();
    if (!selector) continue;
    rules.push({ selector, body: m[2] });
  }
  return rules;
}

function isSelectedFileRowSelector(selector) {
  return String(selector)
    .split(",")
    .some((part) => {
      const p = part.trim();
      if (!p) return false;
      const inExplorer =
        /#file-list\b/.test(p) ||
        /\[data-dir/.test(p) ||
        /#explorer\b/.test(p);
      if (!inExplorer) return false;
      return (
        /aria-selected/.test(p) ||
        /\.selected\b/.test(p) ||
        /\.active\b/.test(p)
      );
    });
}

function usesThemeTokens(body) {
  return /var\(\s*--(?:accent|bg-elevated|fg)\s*(?:,[^)]*)?\)/.test(body);
}

function kebabToCamel(name) {
  return String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToKebab(name) {
  return String(name).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function descendants(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function attrValue(el, name) {
  const key = String(name);
  if (typeof el.getAttribute === "function") {
    const v = el.getAttribute(key);
    if (v != null) return v;
  }
  if (el.attributes && Object.prototype.hasOwnProperty.call(el.attributes, key)) {
    return el.attributes[key];
  }
  if (key.startsWith("data-") && el.dataset) {
    const dk = kebabToCamel(key.slice(5));
    if (el.dataset[dk] != null) return el.dataset[dk];
  }
  return null;
}

function matchCompound(el, compound) {
  const s = String(compound || "").trim();
  if (!s || s === "*") return true;
  let i = 0;
  if (s[0] !== "#" && s[0] !== "." && s[0] !== "[") {
    const m = s.match(/^[a-zA-Z][\w-]*/);
    if (!m) return false;
    if (el.tagName !== m[0].toUpperCase()) return false;
    i = m[0].length;
  }
  const rest = s.slice(i);
  const tokens = [...rest.matchAll(/#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]/g)];
  const consumed = tokens.reduce((n, t) => n + t[0].length, 0);
  if (consumed !== rest.length) return false;
  for (const t of tokens) {
    if (t[1]) {
      if (el.id !== t[1]) return false;
      continue;
    }
    if (t[2]) {
      if (!el.classList?.contains?.(t[2])) return false;
      continue;
    }
    const am = String(t[3]).match(
      /^([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]+)))?$/,
    );
    if (!am) return false;
    const got = attrValue(el, am[1]);
    const want = am[2] ?? am[3] ?? (am[4] != null ? String(am[4]).trim() : null);
    if (want == null) {
      if (got == null || got === "") return false;
    } else if (String(got) !== want) {
      return false;
    }
  }
  return true;
}

function matchesSelector(el, selector, scope) {
  const parts = String(selector || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return false;
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let node = el;
  for (let i = parts.length - 2; i >= 0; i--) {
    node = node.parentNode;
    let found = false;
    while (node && node !== scope) {
      if (matchCompound(node, parts[i])) {
        found = true;
        break;
      }
      node = node.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function queryAll(root, selector, { includeRoot = false } = {}) {
  const groups = String(selector || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const nodes = includeRoot ? [root, ...descendants(root)] : descendants(root);
  const out = [];
  for (const el of nodes) {
    if (groups.some((g) => matchesSelector(el, g, includeRoot ? null : root))) {
      out.push(el);
    }
  }
  return out;
}

function mockClassList(el) {
  const set = new Set();
  const sync = () => {
    const value = [...set].join(" ");
    el.attributes.class = value;
  };
  return {
    add(...names) {
      for (const n of names) {
        const token = String(n).trim();
        if (token) set.add(token);
      }
      sync();
    },
    remove(...names) {
      for (const n of names) set.delete(String(n));
      sync();
    },
    toggle(name, force) {
      const n = String(name);
      if (force === true) set.add(n);
      else if (force === false) set.delete(n);
      else if (set.has(n)) set.delete(n);
      else set.add(n);
      sync();
      return set.has(n);
    },
    contains(name) {
      return set.has(String(name));
    },
    _tokens: set,
  };
}

function mockEl(id, tag = "div") {
  const listeners = {};
  const el = {
    id,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    value: tag === "select" ? "name" : "",
    checked: tag === "input",
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    children: [],
    parentNode: null,
    attributes: {},
    style: {},
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
      for (const fn of listeners[String(type)] || []) fn.call(el, ev);
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
        if (matchCompound(n, want)) return n;
        n = n.parentNode;
      }
      return null;
    },
    matches(sel) {
      return matchCompound(el, sel);
    },
    setAttribute(name, value) {
      const key = String(name);
      const val = String(value);
      el.attributes[key] = val;
      if (key === "id") el.id = val;
      if (key === "hidden") el.hidden = true;
      if (key === "class") el.className = val;
      if (key.startsWith("data-")) {
        const dk = kebabToCamel(key.slice(5));
        el.dataset[dk] = val;
      }
    },
    getAttribute(name) {
      const key = String(name);
      if (Object.prototype.hasOwnProperty.call(el.attributes, key)) {
        return el.attributes[key];
      }
      if (key === "class") return el.className || null;
      if (key.startsWith("data-") && el.dataset) {
        const dk = kebabToCamel(key.slice(5));
        return el.dataset[dk] ?? null;
      }
      return null;
    },
    removeAttribute(name) {
      const key = String(name);
      delete el.attributes[key];
      if (key === "hidden") el.hidden = false;
      if (key === "class") el.className = "";
      if (key.startsWith("data-") && el.dataset) {
        const dk = kebabToCamel(key.slice(5));
        delete el.dataset[dk];
      }
    },
    querySelector(sel) {
      return queryAll(el, sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      return queryAll(el, sel);
    },
  };

  const classList = mockClassList(el);
  el.classList = classList;
  Object.defineProperty(el, "className", {
    get() {
      return [...classList._tokens].join(" ");
    },
    set(value) {
      classList._tokens.clear();
      for (const token of String(value || "")
        .split(/\s+/)
        .filter(Boolean)) {
        classList._tokens.add(token);
      }
      el.attributes.class = [...classList._tokens].join(" ");
    },
    configurable: true,
  });
  el.className = "";

  const data = {};
  el.dataset = new Proxy(data, {
    set(target, key, value) {
      if (typeof key === "symbol") {
        target[key] = value;
        return true;
      }
      const str = value == null ? "" : String(value);
      target[key] = str;
      el.attributes[`data-${camelToKebab(key)}`] = str;
      return true;
    },
    get(target, key) {
      return target[key];
    },
    deleteProperty(target, key) {
      delete target[key];
      delete el.attributes[`data-${camelToKebab(key)}`];
      return true;
    },
  });

  Object.defineProperty(el, "parentElement", {
    get() {
      return el.parentNode;
    },
  });

  return el;
}

function isMarkedSelected(el) {
  if (!el) return false;
  const aria = el.getAttribute?.("aria-selected") ?? el.attributes?.["aria-selected"];
  if (aria === "true" || aria === true) return true;
  if (el.classList?.contains?.("selected") || el.classList?.contains?.("active")) {
    return true;
  }
  const cls = `${el.className || ""} ${el.getAttribute?.("class") || ""}`;
  return /\b(?:selected|active)\b/.test(cls);
}

function fileRows(fileList) {
  return descendants(fileList).filter(
    (el) => el.tagName === "LI" && String(el.dataset?.dir) === "false",
  );
}

function folderRows(fileList) {
  return descendants(fileList).filter(
    (el) => el.tagName === "LI" && String(el.dataset?.dir) === "true",
  );
}

function summaryRows(fileList) {
  return descendants(fileList).filter((el) => el.tagName === "SUMMARY");
}

function rowByPath(fileList, relative) {
  return fileRows(fileList).find((el) => String(el.dataset?.path) === String(relative));
}

function selectedFileRows(fileList) {
  return fileRows(fileList).filter(isMarkedSelected);
}

function boot() {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevCss = globalThis.CSS;

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
    explorer: "aside",
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
  el("status-path").textContent = "";

  const fileList = el("file-list");
  const explorer = el("explorer");
  explorer.appendChild(fileList);

  const doc = {
    documentElement: mockEl("html", "html"),
    body: mockEl("body", "body"),
    getElementById(id) {
      return el(id);
    },
    querySelector(sel) {
      const all = doc.querySelectorAll(sel);
      return all[0] ?? null;
    },
    querySelectorAll(sel) {
      const roots = [doc.documentElement, doc.body, explorer, fileList, ...byId.values()];
      const seen = new Set();
      const out = [];
      for (const root of roots) {
        for (const node of queryAll(root, sel, { includeRoot: true })) {
          if (seen.has(node)) continue;
          seen.add(node);
          out.push(node);
        }
      }
      return out;
    },
    createElement(tag) {
      return mockEl("", tag);
    },
  };
  doc.body.appendChild(explorer);

  const win = {
    document: doc,
  };
  if (!prevCss || typeof prevCss.escape !== "function") {
    win.CSS = {
      escape(value) {
        return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      },
    };
    globalThis.CSS = win.CSS;
  }

  win.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        if (cmd === "list_workspace") {
          return [
            { relative_path: FILE_A, is_dir: false },
            { relative_path: FILE_B, is_dir: false },
            { relative_path: DIR_NOTES, is_dir: true },
            { relative_path: FILE_NESTED, is_dir: false },
          ];
        }
        if (cmd === "read_workspace_file") {
          return `# ${args.relative}\n`;
        }
        return null;
      },
    },
    dialog: {
      async open() {
        return FOLDER;
      },
    },
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.__TAURI__ = win.__TAURI__;

  const scripts = inlineScripts(loadHtml());
  assert.ok(scripts.length > 0, "src/index.html must contain an inline script with applyFile");
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
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    if (prevCss === undefined) delete globalThis.CSS;
    else globalThis.CSS = prevCss;
    delete globalThis.__TAURI__;
  }

  return { win, doc, el, fileList, cleanup };
}

async function openWorkspace(rt) {
  await rt.win.lightmdOpenFolder(FOLDER);
  const files = fileRows(rt.fileList);
  const folders = folderRows(rt.fileList);
  assert.ok(
    rowByPath(rt.fileList, FILE_A),
    `precondition: explorer must render a file row for ${FILE_A} (data-dir=false data-path)`,
  );
  assert.ok(
    rowByPath(rt.fileList, FILE_B),
    `precondition: explorer must render a file row for ${FILE_B}`,
  );
  assert.ok(
    rowByPath(rt.fileList, FILE_NESTED),
    `precondition: explorer must render a nested file row for ${FILE_NESTED}`,
  );
  assert.ok(
    folders.some((row) => String(row.dataset.path) === DIR_NOTES),
    `precondition: explorer must render a folder row for ${DIR_NOTES} (data-dir=true)`,
  );
  assert.ok(files.length >= 3, "precondition: explorer must render multiple file rows");
  return rt;
}

describe("explorer active file highlight", { concurrency: false }, () => {
  test("opening a file marks only the matching file row as selected", async () => {
    const rt = boot();
    try {
      await openWorkspace(rt);
      await rt.win.lightmdOpenFile(FILE_A);

      const active = rowByPath(rt.fileList, FILE_A);
      assert.ok(
        isMarkedSelected(active),
        `after applyFile/open, the matching li[data-dir="false"][data-path="${FILE_A}"] must have aria-selected="true" and/or a selected/active class`,
      );

      const others = fileRows(rt.fileList).filter(
        (row) => String(row.dataset.path) !== FILE_A,
      );
      for (const row of others) {
        assert.equal(
          isMarkedSelected(row),
          false,
          `other file row data-path=${JSON.stringify(row.dataset.path)} must not be selected`,
        );
      }
      assert.equal(
        selectedFileRows(rt.fileList).length,
        1,
        "exactly one file row must be selected after opening a file",
      );
    } finally {
      rt.cleanup();
    }
  });

  test("opening a second file moves the highlight to the new row only", async () => {
    const rt = boot();
    try {
      await openWorkspace(rt);
      await rt.win.lightmdOpenFile(FILE_A);
      await rt.win.lightmdOpenFile(FILE_B);

      const first = rowByPath(rt.fileList, FILE_A);
      const second = rowByPath(rt.fileList, FILE_B);
      assert.equal(
        isMarkedSelected(first),
        false,
        "previous file row must not stay selected after opening another file",
      );
      assert.ok(
        isMarkedSelected(second),
        `only the newly opened row (${FILE_B}) must be selected`,
      );
      assert.equal(
        selectedFileRows(rt.fileList).length,
        1,
        "opening a second file must leave exactly one selected file row",
      );
    } finally {
      rt.cleanup();
    }
  });

  test("folder rows and summaries are never the active file selection", async () => {
    const rt = boot();
    try {
      await openWorkspace(rt);
      await rt.win.lightmdOpenFile(FILE_NESTED);

      const nested = rowByPath(rt.fileList, FILE_NESTED);
      assert.ok(
        isMarkedSelected(nested),
        `opening ${FILE_NESTED} must select the nested file row, not its folder`,
      );

      for (const row of folderRows(rt.fileList)) {
        assert.equal(
          isMarkedSelected(row),
          false,
          `folder row data-dir=true data-path=${JSON.stringify(row.dataset.path)} must never be marked as the active file`,
        );
      }
      for (const summary of summaryRows(rt.fileList)) {
        assert.equal(
          isMarkedSelected(summary),
          false,
          "folder <summary> must never be marked as the active file selection",
        );
      }
    } finally {
      rt.cleanup();
    }
  });

  test("#status-path tracks the open relative path and clears when the file is cleared", async () => {
    const rt = boot();
    try {
      await openWorkspace(rt);
      const status = rt.el("status-path");
      assert.equal(
        String(status.textContent || ""),
        "",
        "#status-path must be empty when no file is open",
      );

      await rt.win.lightmdOpenFile(FILE_A);
      assert.equal(
        status.textContent,
        FILE_A,
        "#status-path textContent must equal the open relative path while a file is open",
      );
      assert.equal(
        rt.win.lightmdWorkspace.relative,
        FILE_A,
        "precondition: currentRelative / lightmdWorkspace.relative must be the open file",
      );

      await rt.win.lightmdOpenFile(FILE_B);
      assert.equal(
        status.textContent,
        FILE_B,
        "#status-path must update to the newly opened relative path",
      );

      await rt.win.lightmdOpenFolder(FOLDER);
      const relative = rt.win.lightmdWorkspace?.relative;
      const cleared = relative == null || relative === "" || relative === false;
      assert.ok(cleared, "Open Folder must clear currentRelative");
      assert.equal(
        String(status.textContent || ""),
        "",
        "#status-path must be empty/cleared when currentRelative is cleared (Open Folder / no file)",
      );
    } finally {
      rt.cleanup();
    }
  });

  test("selected file row CSS uses theme tokens, not a fixed hex", () => {
    const css = styleCss(loadHtml());
    assert.ok(css.trim(), "src/index.html must contain a <style> block");
    const rules = parseRules(css).filter((r) => isSelectedFileRowSelector(r.selector));
    assert.ok(
      rules.length > 0,
      "missing CSS rule for the selected/active explorer file row (#file-list … aria-selected, .selected, or .active)",
    );
    const themed = rules.filter((r) => usesThemeTokens(r.body));
    assert.ok(
      themed.length > 0,
      "selected file row CSS must use theme tokens (--accent and/or --bg-elevated / --fg), not a fixed hex that ignores themes",
    );
  });
});

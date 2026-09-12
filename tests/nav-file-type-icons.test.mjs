import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_HTML = join(root, "src", "index.html");

const NEW_NOTE_RE = /new\s*note/i;
const NEW_FOLDER_RE = /new\s*folder/i;
const ICON_FN_NAMES = [
  "fileTypeIcon",
  "navFileTypeIcon",
  "explorerFileIcon",
  "fileIcon",
  "typeIcon",
];
const KIND_SAMPLES = {
  md: ["notes/readme.md", "a.md", "README.MD"],
  txt: ["notes/readme.txt", "a.txt", "notes.txt"],
  html: ["notes/index.html", "a.html", "page.htm"],
};

function loadHtml() {
  assert.equal(existsSync(INDEX_HTML), true, "src/index.html must exist");
  return readFileSync(INDEX_HTML, "utf8");
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

function taggedById(src, id) {
  const block = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`,
    "i",
  );
  const m = String(src).match(block);
  if (m) {
    return { id, tag: m[1], inner: m[2], full: m[0], index: m.index };
  }
  return null;
}

function parseAttrs(raw) {
  const attrs = {};
  const s = String(raw || "");
  const re = /([:@]?[\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return attrs;
}

function parseButtons(src) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(String(src || "")))) {
    const attrs = parseAttrs(m[1]);
    out.push({
      attrs,
      inner: m[2],
      html: m[0],
      index: m.index,
    });
  }
  return out;
}

function buttonById(buttons, id) {
  return buttons.find((b) => b.attrs.id === String(id)) || null;
}

function accessibleName(btn) {
  return [btn?.attrs?.["aria-label"], btn?.attrs?.title].filter(Boolean).join(" ");
}

function hasSvgIcon(btn) {
  return /<svg\b/i.test(String(btn?.inner || ""));
}

function skipQuoted(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && src[j + 1] === "{") {
      j = skipBlock(src, j + 1);
      continue;
    }
    if (ch === quote) return j + 1;
    j++;
  }
  return src.length;
}

function skipBlock(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(src, i) - 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length - 1 : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length - 1 : end + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

function extractFunction(src, name) {
  const re = new RegExp(
    String.raw`(?:export\s+)?(?:async\s+)?function\s+${name}\s*\(`,
  );
  const m = re.exec(src);
  if (!m) return "";
  const brace = src.indexOf("{", m.index);
  if (brace < 0) return "";
  return src.slice(m.index, skipBlock(src, brace));
}

function extractElseBody(fnSrc, condRe) {
  const m = condRe.exec(fnSrc);
  if (!m) return "";
  const thenBrace = fnSrc.indexOf("{", m.index + m[0].length - 1);
  if (thenBrace < 0) return "";
  const thenEnd = skipBlock(fnSrc, thenBrace);
  const after = fnSrc.slice(thenEnd);
  const elseM = /^\s*else\s*\{/.exec(after);
  if (!elseM) return "";
  const elseBrace = after.indexOf("{");
  const elseEnd = skipBlock(after, elseBrace);
  return after.slice(elseBrace + 1, elseEnd - 1);
}

function iconCallRe() {
  const names = ICON_FN_NAMES.join("|");
  return new RegExp(String.raw`\b(?:${names})\s*\(`);
}

function parseRules(css) {
  const cleaned = String(css || "").replace(/\/\*[\s\S]*?\*\//g, "");
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

function selectorHasId(selector, id) {
  return new RegExp(String.raw`(^|,)\s*#${id}(?:$|[^\w-])`).test(selector);
}

function mockSvgEl(tag) {
  const attrs = {};
  const children = [];
  const dataset = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    attrs,
    attributes: attrs,
    children,
    dataset,
    setAttribute(name, value) {
      const key = String(name);
      const val = String(value);
      attrs[key] = val;
      if (key.startsWith("data-")) {
        const dk = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        dataset[dk] = val;
      }
    },
    getAttribute(name) {
      const key = String(name);
      return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
    append(...nodes) {
      for (const n of nodes) children.push(n);
    },
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return el._innerHTML || "";
    },
    set(html) {
      el._innerHTML = String(html);
      const pathRe = /<path\b([^>]*)>/gi;
      let m;
      while ((m = pathRe.exec(String(html)))) {
        const d = /\bd\s*=\s*(["'])([^"']*)\1/i.exec(m[1]);
        if (d) {
          const path = mockSvgEl("path");
          path.setAttribute("d", d[2]);
          children.push(path);
        }
      }
    },
  });
  return el;
}

function mockSvgDocument() {
  return {
    createElementNS(_ns, tag) {
      return mockSvgEl(tag);
    },
    createElement(tag) {
      return mockSvgEl(tag);
    },
  };
}

function descendants(node) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

function pathDataOf(node) {
  const ds = [];
  for (const n of [node, ...descendants(node)]) {
    const d = n.getAttribute?.("d") ?? n.attrs?.d;
    if (d) ds.push(String(d));
    const html = n._innerHTML || "";
    if (html) {
      for (const m of html.matchAll(/\bd\s*=\s*(["'])([^"']*)\1/gi)) {
        ds.push(m[2]);
      }
    }
  }
  return [...new Set(ds)].join("|");
}

function dataKindOf(node) {
  for (const n of [node, ...descendants(node)]) {
    const ext = n.dataset?.ext ?? n.getAttribute?.("data-ext");
    const type = n.dataset?.type ?? n.getAttribute?.("data-type");
    const kind = n.dataset?.kind ?? n.getAttribute?.("data-kind");
    if (ext != null && String(ext) !== "") return String(ext);
    if (type != null && String(type) !== "") return String(type);
    if (kind != null && String(kind) !== "") return String(kind);
  }
  return "";
}

function evalNavIconHelpers(src) {
  const helperNames = [
    "isUntitledKey",
    "normalizeSlashes",
    "fileNameOf",
    "fileKindOf",
    "createSvg",
    ...ICON_FN_NAMES,
  ];
  const parts = [];
  for (const name of helperNames) {
    const body = extractFunction(src, name);
    if (body) parts.push(body);
  }
  assert.ok(
    extractFunction(src, "fileKindOf"),
    "missing function fileKindOf in src/index.html",
  );
  const iconName = ICON_FN_NAMES.find((n) => extractFunction(src, n));
  assert.ok(
    iconName,
    "missing function fileTypeIcon (or nav-specific equivalent) in src/index.html",
  );

  const document = mockSvgDocument();
  const factory = new Function(
    "document",
    `
      function isUntitledKey(key) { return key == null || key === ""; }
      function normalizeSlashes(value) { return String(value ?? "").replace(/\\\\/g, "/"); }
      ${parts.join("\n")}
      const iconFn = ${ICON_FN_NAMES.map((n) => `typeof ${n} === "function" ? ${n}`).join(" : ")} : null;
      return { fileKindOf, fileTypeIcon: iconFn };
    `,
  );
  return factory(document);
}

const html = loadHtml();
const scripts = inlineScripts(html).join("\n");
assert.ok(scripts.trim(), "src/index.html must contain an inline script");

test("appendNode wires fileTypeIcon into non-dir #file-list rows (not text-only)", () => {
  const body = extractFunction(scripts, "appendNode");
  assert.ok(body, "missing function appendNode (left-nav #file-list render path)");
  assert.match(
    body,
    /dataset\.dir|data-dir/,
    "appendNode must mark explorer rows with data-dir for li[data-dir=false] file rows",
  );

  const fileBody = extractElseBody(body, /if\s*\(\s*node\.is_dir\s*\)/);
  assert.ok(
    fileBody.trim(),
    "appendNode must have a non-dir else branch for file rows (li[data-dir=false])",
  );
  assert.equal(
    /^\s*item\.textContent\s*=\s*displayName\([^;]*\)\s*;\s*$/.test(fileBody),
    false,
    "appendNode file rows must not be text-only (item.textContent = displayName(...)); wire fileTypeIcon (or equivalent) into the non-dir branch",
  );
  assert.ok(
    iconCallRe().test(fileBody) ||
      /<svg\b/i.test(fileBody) ||
      /\bcreateSvg\s*\(/.test(fileBody) ||
      /createElement(?:NS)?\s*\(\s*["']svg["']/i.test(fileBody),
    "appendNode must call fileTypeIcon (or equivalent) for non-dir rows, not only set item.textContent",
  );
});

test("fileKindOf returns distinct kinds for md, txt, and html (txt must not collapse to md)", () => {
  const kindSrc = extractFunction(scripts, "fileKindOf");
  assert.ok(kindSrc, "missing function fileKindOf");
  assert.match(
    kindSrc,
    /\btxt\b/i,
    "fileKindOf must handle .txt as its own kind (txt must not collapse to md)",
  );

  let helpers;
  try {
    helpers = evalNavIconHelpers(scripts);
  } catch (err) {
    assert.fail(`fileKindOf must be evaluable from src/index.html (${err.message})`);
  }
  assert.equal(typeof helpers.fileKindOf, "function", "fileKindOf must be a function");

  const kinds = {
    md: helpers.fileKindOf(KIND_SAMPLES.md[0]),
    txt: helpers.fileKindOf(KIND_SAMPLES.txt[0]),
    html: helpers.fileKindOf(KIND_SAMPLES.html[0]),
  };
  assert.match(
    String(kinds.md),
    /md|markdown/i,
    `fileKindOf(${JSON.stringify(KIND_SAMPLES.md[0])}) must be an md kind (got ${JSON.stringify(kinds.md)})`,
  );
  assert.match(
    String(kinds.txt),
    /txt|text|plain/i,
    `fileKindOf(${JSON.stringify(KIND_SAMPLES.txt[0])}) must be a txt kind, not collapsed to md (got ${JSON.stringify(kinds.txt)})`,
  );
  assert.match(
    String(kinds.html),
    /html?/i,
    `fileKindOf(${JSON.stringify(KIND_SAMPLES.html[0])}) must be an html kind (got ${JSON.stringify(kinds.html)})`,
  );
  assert.notEqual(
    String(kinds.md).toLowerCase(),
    String(kinds.txt).toLowerCase(),
    `fileKindOf must distinguish md vs txt (got md=${JSON.stringify(kinds.md)} txt=${JSON.stringify(kinds.txt)})`,
  );
  assert.notEqual(
    String(kinds.md).toLowerCase(),
    String(kinds.html).toLowerCase(),
    `fileKindOf must distinguish md vs html (got md=${JSON.stringify(kinds.md)} html=${JSON.stringify(kinds.html)})`,
  );
  assert.notEqual(
    String(kinds.txt).toLowerCase(),
    String(kinds.html).toLowerCase(),
    `fileKindOf must distinguish txt vs html (got txt=${JSON.stringify(kinds.txt)} html=${JSON.stringify(kinds.html)})`,
  );

  for (const [kind, samples] of Object.entries(KIND_SAMPLES)) {
    for (const sample of samples) {
      const got = String(helpers.fileKindOf(sample));
      if (kind === "md") {
        assert.match(got, /md|markdown/i, `fileKindOf(${JSON.stringify(sample)}) must stay md (got ${JSON.stringify(got)})`);
      } else if (kind === "txt") {
        assert.match(got, /txt|text|plain/i, `fileKindOf(${JSON.stringify(sample)}) must stay txt (got ${JSON.stringify(got)})`);
      } else {
        assert.match(got, /html?/i, `fileKindOf(${JSON.stringify(sample)}) must stay html (got ${JSON.stringify(got)})`);
      }
    }
  }
});

test("fileTypeIcon uses distinct SVG path data and data-ext/data-type per md/txt/html kind", () => {
  let helpers;
  try {
    helpers = evalNavIconHelpers(scripts);
  } catch (err) {
    assert.fail(`fileTypeIcon must be evaluable from src/index.html (${err.message})`);
  }
  assert.equal(
    typeof helpers.fileTypeIcon,
    "function",
    "fileTypeIcon (or nav-specific equivalent) must be a function",
  );

  const signatures = {};
  for (const kind of ["md", "txt", "html"]) {
    const svg = helpers.fileTypeIcon(KIND_SAMPLES[kind][0]);
    assert.ok(svg, `fileTypeIcon(${JSON.stringify(KIND_SAMPLES[kind][0])}) must return an icon node`);
    const d = pathDataOf(svg);
    const dataKind = dataKindOf(svg);
    const kindValue = dataKind || String(helpers.fileKindOf(KIND_SAMPLES[kind][0]) || "");
    assert.ok(
      d,
      `fileTypeIcon for ${kind} must include SVG path data (d) so icons are not identical across kinds`,
    );
    assert.ok(
      dataKind,
      `fileTypeIcon for ${kind} must set data-ext or data-type (got ${JSON.stringify(dataKind)})`,
    );
    signatures[kind] = { d, dataKind, kindValue };
  }

  const pairs = [
    ["md", "txt"],
    ["md", "html"],
    ["txt", "html"],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(
      signatures[a].d,
      signatures[b].d,
      `fileTypeIcon path d must differ for ${a} vs ${b} (got ${JSON.stringify(signatures[a].d)} vs ${JSON.stringify(signatures[b].d)})`,
    );
    assert.notEqual(
      String(signatures[a].dataKind).toLowerCase(),
      String(signatures[b].dataKind).toLowerCase(),
      `fileTypeIcon data-ext/data-type must differ for ${a} vs ${b} (got ${JSON.stringify(signatures[a].dataKind)} vs ${JSON.stringify(signatures[b].dataKind)})`,
    );
  }
});

test("#explorer-toolbar has #new-note and #new-folder with SVG icons and accessible names", () => {
  const toolbar = taggedById(html, "explorer-toolbar");
  assert.ok(toolbar, "missing #explorer-toolbar");

  const buttons = parseButtons(toolbar.full);
  const newNote = buttonById(buttons, "new-note");
  const newFolder = buttonById(buttons, "new-folder");
  assert.ok(newNote, "missing button#new-note in #explorer-toolbar");
  assert.ok(
    newFolder,
    "missing button#new-folder in #explorer-toolbar (must sit near #new-note)",
  );

  assert.equal(
    hasSvgIcon(newNote),
    true,
    `#new-note must contain an SVG icon (inner=${JSON.stringify(String(newNote.inner).trim())})`,
  );
  assert.equal(
    hasSvgIcon(newFolder),
    true,
    `#new-folder must contain an SVG icon (inner=${JSON.stringify(String(newFolder.inner).trim())})`,
  );

  const noteName = accessibleName(newNote);
  const folderName = accessibleName(newFolder);
  assert.ok(
    NEW_NOTE_RE.test(noteName),
    `#new-note accessible name via aria-label and/or title must match /new\\s*note/i (got aria-label=${JSON.stringify(newNote.attrs["aria-label"] || "")} title=${JSON.stringify(newNote.attrs.title || "")})`,
  );
  assert.ok(
    NEW_FOLDER_RE.test(folderName),
    `#new-folder accessible name via aria-label and/or title must match /new\\s*folder/i (got aria-label=${JSON.stringify(newFolder.attrs["aria-label"] || "")} title=${JSON.stringify(newFolder.attrs.title || "")})`,
  );
});

test("toolbar chrome density CSS includes #new-folder alongside #new-note", () => {
  const rules = parseRules(styleCss(html));
  const shared = rules.filter(
    (r) => selectorHasId(r.selector, "new-note") && selectorHasId(r.selector, "new-folder"),
  );
  assert.ok(
    shared.length > 0,
    "#new-folder should share toolbar chrome density selectors with #new-note (width/height/icon size)",
  );
});

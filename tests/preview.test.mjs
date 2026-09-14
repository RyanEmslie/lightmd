import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadSourceText } from "./helpers/source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const pkgPath = join(root, "package.json");
const fixturePath = join(root, "tests", "fixtures", "preview.md");
const YAML_SECRET = "yaml-secret-not-in-preview-body";

function loadPkg() {
  assert.equal(existsSync(pkgPath), true, "package.json must exist");
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}

function loadSources() {
  return loadSourceText();
}

function loadFixture() {
  assert.equal(existsSync(fixturePath), true, "tests/fixtures/preview.md must exist");
  const source = readFileSync(fixturePath, "utf8");
  assert.match(source, /\|[^|\n]+\|[^|\n]+\|/, "fixture must include a GFM table");
  assert.match(source, /^\s*[-*]\s+\[[ xX]\]\s+/m, "fixture must include a GFM task list");
  assert.match(source, /~~[^~\n]+~~/, "fixture must include GFM strikethrough");
  assert.match(source, /^```/m, "fixture must include a fenced code block");
  assert.match(source, /!\[[^\]]*\]\([^)]+\)/, "fixture must include an image");
  return source;
}

function fixtureBody(source) {
  const match = source.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? source.slice(match[0].length) : source;
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asPreviewConfig(value) {
  if (!value || typeof value !== "object") return null;
  if (value.preview && typeof value.preview === "object") {
    const nested = asPreviewConfig(value.preview);
    if (nested) return nested;
  }
  const live = firstOf(
    value.live,
    value.livePreview,
    value.updateWhileTyping,
    typeof value.updateOnSave === "boolean" ? !value.updateOnSave : undefined,
    value.mode === "live" || value.mode === "typing"
      ? true
      : value.mode === "save"
        ? false
        : undefined,
    value.on === "type" || value.on === "typing"
      ? true
      : value.on === "save"
        ? false
        : undefined,
  );
  if (typeof live === "boolean") return { live };
  return null;
}

function pickPreviewConfig(mod) {
  if (!mod || typeof mod !== "object") return null;
  const names = [
    "preview",
    "previewConfig",
    "livePreview",
    "config",
    "settings",
    "defaults",
    "default",
  ];
  for (const name of names) {
    const cfg = asPreviewConfig(mod[name]);
    if (cfg) return cfg;
  }
  const live = firstOf(
    mod.PREVIEW_LIVE,
    mod.previewLive,
    mod.livePreview,
    mod.LIVE_PREVIEW,
    typeof mod.PREVIEW_UPDATE_ON_SAVE === "boolean"
      ? !mod.PREVIEW_UPDATE_ON_SAVE
      : undefined,
    typeof mod.updateOnSave === "boolean" ? !mod.updateOnSave : undefined,
  );
  if (typeof live === "boolean") return { live };
  return asPreviewConfig(mod);
}

function configFromSource(src) {
  const liveMatch =
    src.match(
      /\bpreview[\s\S]{0,400}?\b(?:live|livePreview|updateWhileTyping)\s*:\s*(true|false)/i,
    ) ||
    src.match(
      /\b(?:live|livePreview|updateWhileTyping)\s*:\s*(true|false)[\s\S]{0,400}?\bpreview/i,
    ) ||
    src.match(/\bpreview(?:Live|_LIVE)?\s*[:=]\s*(true|false)/i);

  const saveMatch = src.match(
    /\b(?:updateOnSave|saveOnly|previewOnSave)\s*:\s*(true|false)/i,
  );

  if (liveMatch) return { live: liveMatch[1] === "true" };
  if (saveMatch) return { live: saveMatch[1] !== "true" };
  return null;
}

async function loadPreviewConfig() {
  const names = [
    "config.js",
    "config.mjs",
    "settings.js",
    "settings.mjs",
    "preview.js",
    "preview.mjs",
    "markdown.js",
    "markdown.mjs",
    "editor.js",
  ];
  for (const name of names) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const cfg = pickPreviewConfig(mod);
      if (cfg) return cfg;
    } catch {
      // Missing export or unusable in Node: keep looking, then scan source.
    }
  }
  return configFromSource(loadSources());
}

function pickRender(mod) {
  const names = [
    "renderPreview",
    "renderMarkdown",
    "renderGfm",
    "markdownToHtml",
    "toHtml",
    "render",
  ];
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  if (typeof mod.default === "function") return mod.default;
  if (mod.default && typeof mod.default === "object") {
    for (const name of names) {
      if (typeof mod.default[name] === "function") return mod.default[name];
    }
    if (typeof mod.default.render === "function") {
      return (markdown) => mod.default.render(markdown);
    }
  }
  for (const key of ["md", "markdownIt", "markdownit", "gfm"]) {
    if (mod[key] && typeof mod[key].render === "function") {
      return (markdown) => mod[key].render(markdown);
    }
  }
  return null;
}

async function loadRender() {
  const names = [
    "preview.js",
    "preview.mjs",
    "markdown.js",
    "markdown.mjs",
    "gfm.js",
    "gfm.mjs",
    "render.js",
    "render.mjs",
    "editor.js",
  ];
  for (const name of names) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const fn = pickRender(mod);
      if (fn) return fn;
    } catch {
      // Missing or unusable module: keep looking, then fail as missing preview.
    }
  }
  return null;
}

function normalizeHtml(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result.html === "string") return result.html;
  if (typeof result.body === "string") return result.body;
  if (typeof result.innerHTML === "string") return result.innerHTML;
  return String(result);
}

function usesMarkdownIt(src) {
  return (
    /from\s+["']markdown-it["']/.test(src) ||
    /require\(\s*["']markdown-it["']\s*\)/.test(src) ||
    /\bmarkdown-it\b/.test(src) ||
    /\bMarkdownIt\b/.test(src) ||
    /\bmarkdownit\b/.test(src)
  );
}

function usesMarkdownItGfm(src) {
  if (!usesMarkdownIt(src)) return false;
  if (!/html\s*:\s*false/.test(src)) return false;
  const gfmBundle = /markdown-it-gfm|@mdit\/plugin-gfm|markdownItGfm/.test(src);
  const tasks = /task[-_]?lists?|markdown-it-task|plugin-tasklist|TaskList/i.test(
    src,
  );
  return gfmBundle || tasks;
}

function hasPreviewBody(src) {
  return (
    /\bid=["']preview-body["']/.test(src) ||
    /\.id\s*=\s*["']preview-body["']/.test(src) ||
    /getElementById\(\s*["']preview-body["']\s*\)/.test(src) ||
    /#preview-body\b/.test(src)
  );
}

function previewBodyRendersGfm(src) {
  if (!hasPreviewBody(src) || !usesMarkdownIt(src)) return false;
  const assigns =
    /(?:previewBody|preview-body|#preview\b)[\s\S]{0,400}?\.innerHTML\s*=/.test(
      src,
    ) ||
    /(?:previewBody|preview-body|#preview\b)[\s\S]{0,400}?(?:insertAdjacentHTML|setHTML)\s*\(/.test(
      src,
    ) ||
    /\.innerHTML\s*=[\s\S]{0,400}?(?:previewBody|preview-body|#preview\b)/.test(
      src,
    );
  const rendered =
    /\.render\s*\(|renderPreview|renderMarkdown|renderGfm|markdownToHtml/.test(
      src,
    );
  return assigns && rendered;
}

function hasLivePreviewWhileTyping(src) {
  const typing =
    /\bupdateListener\b/.test(src) ||
    /\bdocChanged\b/.test(src) ||
    /addEventListener\(\s*["'](?:input|keyup|change)["']/.test(src);
  const preview =
    /\bsetPreview\b|\brenderPreview\b|previewBody|#preview-body/.test(src);
  return typing && preview && usesMarkdownIt(src);
}

function previewUsesParsedBody(src) {
  const body =
    /parsed\.body/.test(src) ||
    /parseFrontmatter\([^)]*\)\.body/.test(src) ||
    /(?:frontmatter|matter|split)\.body/.test(src);
  const preview =
    /\bsetPreview\b|\brenderPreview\b|previewBody|#preview-body/.test(src);
  return body && preview && usesMarkdownIt(src);
}

function assignsRawFileBufferViaInnerHTML(src) {
  const re = /(?:[A-Za-z_$][\w.$]*)?\.innerHTML\s*=\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const rhs = m[1];
    if (
      /\.render\s*\(|renderPreview|renderMarkdown|renderGfm|markdownToHtml|sanitize/.test(
        rhs,
      )
    ) {
      continue;
    }
    if (
      /\b(?:buffer(?:\.value)?|contents|fileContents|fileText|raw)\b/.test(
        rhs,
      ) ||
      /(?:read_workspace_file|readFile)/.test(rhs)
    ) {
      return true;
    }
    if (
      /^\s*(?:await\s+)?(?:body|contents|text|markdown|data|result|file)\s*$/.test(
        rhs,
      )
    ) {
      return true;
    }
  }
  return false;
}

function assertGfmHtml(html) {
  assert.match(html, /<table\b/i, "preview must render a GFM table");
  assert.match(
    html,
    /<input\b[^>]*type=["']checkbox["']|task-list-item|contains-task-list/i,
    "preview must render a GFM task list",
  );
  assert.match(html, /<(?:del|s)\b/i, "preview must render GFM strikethrough");
  assert.match(
    html,
    /<pre\b[\s\S]*?<code\b/i,
    "preview must render fenced code",
  );
  assert.match(html, /<img\b/i, "preview must render an image");
  assert.match(html, /gfm-table-cell-alpha/, "preview must include table cells");
  assert.match(html, /gfm-task-done/, "preview must include the task list");
  assert.match(html, /gfm-strike-text/, "preview must include strikethrough text");
  assert.match(html, /gfm-fenced-code-token/, "preview must include fenced code");
  assert.match(html, /gfm-image-alt/, "preview must include the image alt");
}

test("package.json depends on markdown-it", () => {
  const pkg = loadPkg();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(
    "markdown-it" in deps,
    "missing markdown-it (package.json must depend on markdown-it)",
  );
});

test("preview uses markdown-it + GFM with html:false (raw HTML in Markdown is not executed)", () => {
  const src = loadSources();
  assert.ok(
    usesMarkdownIt(src),
    "missing markdown-it preview",
  );
  assert.ok(
    /html\s*:\s*false/.test(src),
    "missing markdown-it html:false (raw HTML in Markdown is not executed)",
  );
  assert.ok(
    usesMarkdownItGfm(src),
    "missing markdown-it GFM (tables, task lists, strikethrough)",
  );
});

test("live preview default on (testable config: option to update only on save)", async () => {
  const config = await loadPreviewConfig();
  assert.ok(
    config,
    "missing live preview config (JS object/export: live on, or update only on save)",
  );
  assert.equal(config.live, true, "default live preview must be on");
});

test("live preview updates while typing", () => {
  const src = loadSources();
  assert.ok(
    hasLivePreviewWhileTyping(src),
    "missing live markdown-it preview (updates while typing)",
  );
});

test("#preview-body renders GFM fixture (table, task list, strikethrough, fenced code, img)", async () => {
  const source = loadFixture();
  const src = loadSources();
  const body = fixtureBody(source);

  assert.ok(hasPreviewBody(src), "missing #preview-body");
  assert.equal(
    assignsRawFileBufferViaInnerHTML(src),
    false,
    "raw file buffer is not assigned via innerHTML (markdown-it output into #preview-body is allowed)",
  );

  const render = await loadRender();
  assert.ok(
    render || previewBodyRendersGfm(src),
    "missing markdown-it preview that renders GFM in #preview-body",
  );
  assert.ok(
    previewUsesParsedBody(src),
    "preview must use parsed.body so YAML is not rendered as markdown",
  );

  if (render) {
    const html = normalizeHtml(render(body));
    assertGfmHtml(html);
    assert.equal(
      html.includes(YAML_SECRET),
      false,
      "preview must use parsed.body so YAML is not rendered as markdown",
    );
    assert.equal(
      /<script\b/i.test(html),
      false,
      "raw HTML in Markdown is not executed",
    );
  }
});

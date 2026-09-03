import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const workspaceDir = join(root, "tests", "fixtures", "workspace");
const picPath = join(workspaceDir, "pic.png");
const LOCAL_IMAGE_MD = "![pic](./pic.png)\n";

function collectSource(dir) {
  const chunks = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      chunks.push(...collectSource(p));
      continue;
    }
    if (ent.name === "editor.bundle.js") continue;
    if (/\.(html|js|mjs|cjs|ts|css)$/i.test(ent.name)) {
      chunks.push(readFileSync(p, "utf8"));
    }
  }
  return chunks;
}

function loadSources() {
  assert.equal(existsSync(srcDir), true, "src/ must exist");
  const files = collectSource(srcDir);
  assert.ok(files.length > 0, "src/ must contain editor source");
  return files.join("\n");
}

function targetsPreview(selector) {
  return (
    /#preview-body\b/.test(selector) || /#preview(?:[^\w-]|$)/.test(selector)
  );
}

function previewStyleText(src) {
  const chunks = [];
  const cssRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = cssRe.exec(src))) {
    if (targetsPreview(m[1])) chunks.push(m[2]);
  }
  const tagRe = /<[^>]*\bid=["']preview(?:-body)?["'][^>]*>/gi;
  while ((m = tagRe.exec(src))) {
    const style = m[0].match(/style=["']([^"']*)["']/i);
    if (style) chunks.push(style[1]);
  }
  const jsRe =
    /(?:["']#preview(?:-body)?["']|#preview-body\b|#preview(?:[^\w-]|$))[\s\S]{0,400}/gi;
  while ((m = jsRe.exec(src))) {
    chunks.push(m[0]);
  }
  return chunks.join("\n");
}

function hasSystemUiSans(css) {
  return /system-ui/.test(css) && /sans-serif/.test(css);
}

function hasSize16(css) {
  return (
    /font-size\s*[:=]\s*["']?16px/.test(css) ||
    /fontSize\s*[:=]\s*["']?16px/.test(css) ||
    /font\s*:\s*[^;\n]*16px/.test(css)
  );
}

function hasLineHeight155(css) {
  return (
    /line-height\s*[:=]\s*["']?1\.55\b/.test(css) ||
    /lineHeight\s*[:=]\s*["']?1\.55\b/.test(css) ||
    /font\s*:\s*[^;\n]*\/\s*1\.55\b/.test(css)
  );
}

function hasMeasure72ch(css) {
  return (
    /max-width\s*[:=]\s*["']?72ch/.test(css) ||
    /maxWidth\s*[:=]\s*["']?72ch/.test(css) ||
    /width\s*[:=]\s*["']?72ch/.test(css)
  );
}

function hasLocalImageWiring(src) {
  const loader =
    /\bconvertFileSrc\b/.test(src) ||
    /\bread_workspace_image\b/.test(src) ||
    /invoke\(\s*["']read_(?:workspace_)?image["']/.test(src) ||
    (/\bread_image\b/.test(src) && /(?:img|src|png|image)/i.test(src)) ||
    /data:image\//.test(src) ||
    /asset:\/\//.test(src);
  const walks =
    /renderer\.rules\.image/.test(src) ||
    /querySelector(?:All)?\(\s*["']img["']/.test(src) ||
    /\.attr(?:Get|Set)\(\s*["']src["']/.test(src) ||
    /\.\/pic\.png/.test(src) ||
    /!\[[^\]]*\]\(\.\/pic\.png\)/.test(src) ||
    /\bsrc\b[\s\S]{0,200}(?:png|jpe?g|gif|webp|svg|\.\/)/i.test(src) ||
    /(?:relative|workspace).{0,80}(?:image|img|png)/i.test(src) ||
    /(?:image|img|png).{0,80}(?:relative|workspace)/i.test(src);
  return loader && walks;
}

function isRemoteImageSrc(value) {
  if (!/^https?:\/\//i.test(value)) return false;
  return !/asset\.localhost|tauri\.localhost/i.test(value);
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
  return null;
}

function pickImageFn(mod) {
  const names = [
    "resolvePreviewImage",
    "rewritePreviewImages",
    "localImageSrc",
    "previewImageSrc",
    "resolveImageSrc",
    "rewriteImages",
    "loadPreviewImage",
    "toPreviewImageSrc",
  ];
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  return null;
}

async function loadPreviewModule() {
  const names = [
    "preview.js",
    "preview.mjs",
    "markdown.js",
    "markdown.mjs",
    "images.js",
    "images.mjs",
    "editor.js",
  ];
  for (const name of names) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    try {
      return await import(pathToFileURL(p).href);
    } catch {
      // Missing export or unusable in Node: keep looking.
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
  if (typeof result.src === "string") return `<img src="${result.src}">`;
  return String(result);
}

function tryRender(render, markdown, workspace) {
  const attempts = [
    () => render(markdown),
    () => render(markdown, workspace),
    () => render(markdown, { workspace, root: workspace }),
    () => render(markdown, { workspace, relative: "note.md" }),
    () => render(markdown, { workspacePath: workspace, file: "note.md" }),
    () => render(markdown, workspace, "note.md"),
  ];
  let html = "";
  for (const attempt of attempts) {
    try {
      const out = attempt();
      if (out && typeof out.then === "function") continue;
      html = normalizeHtml(out);
      if (/<img\b/i.test(html)) return html;
    } catch {
      // Signature mismatch: try the next shape.
    }
  }
  return html;
}

function imgSrcs(html) {
  return [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(
    (m) => m[1],
  );
}

test("#preview-body (or preview) type is system UI sans 16px / 1.55", () => {
  const src = loadSources();
  const css = previewStyleText(src);
  assert.ok(
    hasSystemUiSans(css) && hasSize16(css) && hasLineHeight155(css),
    "missing #preview-body type (system UI sans, 16px, line-height 1.55)",
  );
});

test("preview measure is max 72ch inside the pane", () => {
  const src = loadSources();
  const css = previewStyleText(src);
  assert.ok(hasMeasure72ch(css), "missing preview measure max 72ch");
});

test("preview uses local relative ./pic.png (no remote images)", async () => {
  assert.equal(
    existsSync(picPath),
    true,
    "tests/fixtures/workspace/pic.png must exist",
  );
  const pic = readFileSync(picPath);
  assert.equal(pic[0], 0x89, "fixture pic.png must be a PNG");

  const src = loadSources();
  assert.ok(
    hasLocalImageWiring(src),
    "missing local relative ./pic.png for preview images",
  );

  const mod = await loadPreviewModule();
  const render = mod ? pickRender(mod) : null;
  const resolve = mod ? pickImageFn(mod) : null;

  if (render) {
    const html = tryRender(render, LOCAL_IMAGE_MD, workspaceDir);
    for (const value of imgSrcs(html)) {
      assert.equal(
        isRemoteImageSrc(value),
        false,
        "local relative images only (no remote images)",
      );
    }
  }

  if (resolve) {
    let out;
    try {
      out = resolve("./pic.png", workspaceDir);
    } catch {
      out = undefined;
    }
    const text = normalizeHtml(out);
    assert.equal(
      /https?:\/\//i.test(text) && isRemoteImageSrc(text),
      false,
      "local relative images only (no remote images)",
    );
  }
});

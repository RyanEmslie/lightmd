import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

const md = new MarkdownIt({ html: false }).use(taskLists);

// A workspace image's markdown src. renderPreview puts it here instead of in
// src, and rewritePreviewImages sets src to the image's data: URL.
const ORIGINAL_SRC = "data-lightmd-src";

function isBlockedImageSrc(src) {
  const s = String(src || "");
  if (/^(?:https?:|\/\/)/i.test(s)) return true;
  if (/^(?:javascript|vbscript):/i.test(s)) return true;
  if (/^data:/i.test(s) && !/^data:image\//i.test(s)) return true;
  return false;
}

const defaultImageRule =
  md.renderer.rules.image ||
  function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.image = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const srcIndex = token.attrIndex("src");
  if (srcIndex >= 0 && isBlockedImageSrc(token.attrs[srcIndex][1])) {
    token.attrs[srcIndex][1] = "";
  } else if (srcIndex >= 0 && token.attrs[srcIndex][1] && !hasScheme(token.attrs[srcIndex][1])) {
    // A workspace image gets its src from rewritePreviewImages; a relative
    // src here would only make the webview fetch a URL that 404s.
    token.attrs[srcIndex][0] = ORIGINAL_SRC;
  }
  return defaultImageRule(tokens, idx, options, env, self);
};

// Headings get unique GitHub-style slug ids. The prefix (GitHub's too) keeps a
// heading such as "# Preview" from taking an app element's id.
export const HEADING_ID_PREFIX = "user-content-";

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

md.core.ruler.push("heading_ids", (state) => {
  const used = new Map();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "heading_open") continue;
    const parts = (tokens[i + 1]?.children || [])
      .filter((t) => t.type === "text" || t.type === "code_inline")
      .map((t) => t.content);
    const base = slugify(parts.join("")) || "section";
    let slug = base;
    if (used.has(base)) {
      let n = used.get(base);
      do {
        n += 1;
        slug = `${base}-${n}`;
      } while (used.has(slug));
      used.set(base, n);
    }
    used.set(slug, 0);
    tokens[i].attrSet("id", HEADING_ID_PREFIX + slug);
  }
});

// Block elements carry the source line they start on (data-line, 0-based in
// the whole file: env.lineOffset counts the frontmatter lines above the body),
// so the outline and scroll sync can map preview positions to editor lines.
md.core.ruler.push("source_lines", (state) => {
  const offset = (state.env && state.env.lineOffset) || 0;
  for (const token of state.tokens) {
    if (token.map && token.nesting >= 0 && token.level === 0) {
      token.attrSet("data-line", String(token.map[0] + offset));
    }
  }
});

// The headings of a markdown body: { level, text, id, line } in document order,
// with the same ids the rendered preview gives them.
export function outlineFromMarkdown(markdown, lineOffset = 0) {
  const tokens = md.parse(markdown ?? "", { lineOffset });
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open") continue;
    out.push({
      level: Number(t.tag.slice(1)),
      text: (tokens[i + 1]?.children || [])
        .filter((c) => c.type === "text" || c.type === "code_inline")
        .map((c) => c.content)
        .join("")
        .trim(),
      id: t.attrGet("id"),
      line: (t.map ? t.map[0] : 0) + lineOffset,
    });
  }
  return out;
}

// Default live on; set live: false to update the preview only on save.
export const preview = {
  live: true,
};

// Workspace images become data: URLs. Reads in flight are shared, misses are
// remembered for missTtlMs, and the cache keeps at most maxChars of data URLs,
// dropping the least recently used first.
export const previewImageCache = {
  maxChars: 50 * 1024 * 1024,
  missTtlMs: 5000,
};
const imageCache = new Map(); // key -> data URL, least recently used first
let imageCacheChars = 0;
const imageReads = new Map(); // key -> pending read
const imageMisses = new Map(); // key -> Date.now() when the miss expires
let rewriteSeq = 0;

function hasScheme(src) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
}

function parentDir(fileRelative) {
  const n = String(fileRelative || "").replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i === -1 ? "" : n.slice(0, i);
}

function decodeSegment(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

// Maps a (markdown-it percent-encoded) URL path to a workspace-relative file:
// ?query and #hash are dropped, a leading / means the workspace root, and
// null means it would leave the workspace.
function confinedWorkspaceRelative(src, fileRelative = "") {
  const path = String(src).replace(/[?#].*$/s, "").replace(/\\/g, "/");
  const start = path.startsWith("/") ? "" : parentDir(fileRelative);
  const parts = start ? start.split("/").filter(Boolean) : [];
  for (const raw of path.split("/")) {
    const part = decodeSegment(raw);
    if (/[/\\\0]/.test(part)) return null;
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/") || null;
}

function joinRoot(workspace, relative) {
  const root = String(workspace).replace(/[/\\]+$/, "");
  const rel = String(relative).replace(/\\/g, "/");
  if (!root) return rel;
  return root.includes("\\") ? `${root}\\${rel.replace(/\//g, "\\")}` : `${root}/${rel}`;
}

function mimeFromRelative(relative) {
  const ext = String(relative).split(".").pop().toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/png";
}

// read_workspace_image returns raw bytes, which arrive as an ArrayBuffer.
function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes && Array.isArray(bytes.data)) return Uint8Array.from(bytes.data);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  return null;
}

function bytesToDataUrl(bytes, mime) {
  const arr = toUint8Array(bytes);
  if (!arr) return null;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function resolvePreviewImage(src, workspace, fileRelative = "") {
  if (!src) return src;
  if (isBlockedImageSrc(src)) return "";
  if (hasScheme(src)) return src;
  const relative = confinedWorkspaceRelative(src, fileRelative);
  if (relative == null) return src;
  const convert = globalThis.__TAURI__?.core?.convertFileSrc;
  if (typeof convert === "function" && workspace) {
    return convert(joinRoot(workspace, relative));
  }
  if (workspace) return joinRoot(workspace, relative);
  return relative;
}

function cacheImage(key, url) {
  if (url.length > previewImageCache.maxChars) return;
  imageCache.set(key, url);
  imageCacheChars += url.length;
  for (const [oldKey, oldUrl] of imageCache) {
    if (imageCacheChars <= previewImageCache.maxChars) break;
    imageCache.delete(oldKey);
    imageCacheChars -= oldUrl.length;
  }
}

function cachedImage(key) {
  const url = imageCache.get(key);
  if (url === undefined) return undefined;
  imageCache.delete(key);
  imageCache.set(key, url);
  return url;
}

function rememberMiss(key) {
  imageMisses.set(key, Date.now() + previewImageCache.missTtlMs);
  return null;
}

// Forget cached images and misses so files changed on disk are read again.
// Reads already in flight see the file as it is now, so they stay shared.
export function invalidatePreviewImages() {
  imageCache.clear();
  imageCacheChars = 0;
  imageMisses.clear();
}

function loadWorkspaceImage(workspace, relative) {
  const key = `${workspace}\0${relative}`;
  const cached = cachedImage(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = imageReads.get(key);
  if (pending) return pending;
  if (imageMisses.has(key)) {
    if (Date.now() < imageMisses.get(key)) return Promise.resolve(null);
    imageMisses.delete(key);
  }
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") return Promise.resolve(null);
  const read = Promise.resolve()
    .then(() => invoke("read_workspace_image", { path: workspace, relative }))
    .then(
      (bytes) => {
        const url = bytesToDataUrl(bytes, mimeFromRelative(relative));
        if (!url) return rememberMiss(key);
        cacheImage(key, url);
        return url;
      },
      () => rememberMiss(key),
    )
    .finally(() => {
      imageReads.delete(key);
    });
  imageReads.set(key, read);
  return read;
}

export async function rewritePreviewImages(root, workspace, fileRelative) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const seq = ++rewriteSeq;
  const imgs = [...root.querySelectorAll("img")];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute(ORIGINAL_SRC) || img.getAttribute("src") || "";
      if (!src) return;
      if (isBlockedImageSrc(src)) {
        img.removeAttribute("src");
        return;
      }
      if (hasScheme(src)) return;
      const relative = confinedWorkspaceRelative(src, fileRelative);
      if (relative == null || !workspace) return;
      const url = await loadWorkspaceImage(workspace, relative);
      if (!url || seq !== rewriteSeq) return;
      img.setAttribute(ORIGINAL_SRC, src);
      img.setAttribute("src", url);
    }),
  );
}

export function renderPreview(markdown, lineOffset = 0) {
  return md.render(markdown ?? "", { lineOffset });
}

function isHttpHref(href) {
  return /^https?:\/\//i.test(href);
}

export function openPreviewLink(url) {
  const tauri = globalThis.__TAURI__;
  if (!tauri) return;
  if (tauri.opener && typeof tauri.opener.openUrl === "function") {
    return tauri.opener.openUrl(url);
  }
  const invoke = tauri.core?.invoke;
  if (typeof invoke === "function") {
    return invoke("plugin:opener|open_url", { url });
  }
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function scrollToHeading(root, fragment) {
  const name = decodeFragment(fragment);
  const doc = root && root.ownerDocument;
  if (!name || !doc || typeof doc.getElementById !== "function") return;
  for (const id of [HEADING_ID_PREFIX + name, HEADING_ID_PREFIX + name.toLowerCase(), name]) {
    const el = doc.getElementById(id);
    if (el && el !== root && root.contains(el)) {
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
      return;
    }
  }
}

const OPENABLE_LINK = /\.(?:md|html|htm)$/i;

// A relative .md/.html link opens through the app's open-file path, confined
// to the workspace, then scrolls to its #fragment if it has one.
async function openWorkspaceLink(href, root) {
  const open = globalThis.lightmdOpenFile;
  if (typeof open !== "function") return;
  const ws = globalThis.lightmdWorkspace;
  const relative = confinedWorkspaceRelative(href, ws && ws.relative);
  if (!relative || !OPENABLE_LINK.test(relative)) return;
  await open(relative);
  if (typeof globalThis.lightmdPersistSession === "function") {
    globalThis.lightmdPersistSession({ lastFile: relative, file: relative });
  }
  const hash = href.indexOf("#");
  if (hash >= 0) scrollToHeading(root, href.slice(hash + 1));
}

export function handlePreviewClick(event, root = event.currentTarget) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;
  const anchor = target.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href") || "";
  event.preventDefault();
  if (isHttpHref(href)) {
    void openPreviewLink(href);
    return;
  }
  if (href.startsWith("#")) {
    scrollToHeading(root, href.slice(1));
    return;
  }
  if (hasScheme(href)) return;
  return openWorkspaceLink(href, root);
}

export function bindPreviewLinks(root) {
  if (!root || typeof root.addEventListener !== "function") return;
  root.addEventListener("click", (event) => handlePreviewClick(event, root));
}

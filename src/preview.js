import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

const md = new MarkdownIt({ html: false }).use(taskLists);

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
  }
  return defaultImageRule(tokens, idx, options, env, self);
};

// Default live on; set live: false to update the preview only on save.
export const preview = {
  live: true,
};

const imageCache = new Map();
let rewriteSeq = 0;

function hasScheme(src) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
}

function parentDir(fileRelative) {
  const n = String(fileRelative || "").replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i === -1 ? "" : n.slice(0, i);
}

function confinedWorkspaceRelative(src, fileRelative = "") {
  const start = parentDir(fileRelative);
  const parts = start ? start.split("/").filter(Boolean) : [];
  for (const part of String(src).replace(/\\/g, "/").split("/")) {
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

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer);
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

async function loadWorkspaceImage(workspace, relative) {
  const key = `${workspace}\0${relative}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") return null;
  try {
    const bytes = await invoke("read_workspace_image", {
      path: workspace,
      relative,
    });
    const url = bytesToDataUrl(bytes, mimeFromRelative(relative));
    if (url) imageCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

export async function rewritePreviewImages(root, workspace, fileRelative) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const seq = ++rewriteSeq;
  const imgs = [...root.querySelectorAll("img")];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") || "";
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
      img.setAttribute("src", url);
    }),
  );
}

export function renderPreview(markdown) {
  return md.render(markdown ?? "");
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

export function handlePreviewClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;
  const anchor = target.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href") || "";
  event.preventDefault();
  if (!isHttpHref(href)) return;
  void openPreviewLink(href);
}

export function bindPreviewLinks(root) {
  if (!root || typeof root.addEventListener !== "function") return;
  root.addEventListener("click", handlePreviewClick);
}

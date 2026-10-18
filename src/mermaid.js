// Mermaid diagrams in the markdown preview, rendered to SVG by Pele
// (https://pele.run). renderPreview turns ```mermaid fences into
// .mermaid-diagram placeholders; renderMermaidDiagrams fills them in.
//
// Diagram types are registered statically from pele/core: the editor bundle
// is a single esbuild IIFE, so pele/lazy's dynamic imports have nowhere to go.
import { register, render } from "pele/core";
import architecture from "pele/diagrams/architecture";
import block from "pele/diagrams/block";
import classDiagram from "pele/diagrams/class";
import er from "pele/diagrams/er";
import flowchart from "pele/diagrams/flowchart";
import gantt from "pele/diagrams/gantt";
import gitGraph from "pele/diagrams/gitGraph";
import journey from "pele/diagrams/journey";
import kanban from "pele/diagrams/kanban";
import mindmap from "pele/diagrams/mindmap";
import packet from "pele/diagrams/packet";
import pie from "pele/diagrams/pie";
import quadrantChart from "pele/diagrams/quadrantChart";
import radar from "pele/diagrams/radar";
import requirement from "pele/diagrams/requirement";
import sankey from "pele/diagrams/sankey";
import sequence from "pele/diagrams/sequence";
import state from "pele/diagrams/state";
import timeline from "pele/diagrams/timeline";
import treemap from "pele/diagrams/treemap";
import xychart from "pele/diagrams/xychart";

register(
  flowchart,
  sequence,
  classDiagram,
  state,
  er,
  gantt,
  pie,
  mindmap,
  timeline,
  journey,
  gitGraph,
  quadrantChart,
  xychart,
  kanban,
  sankey,
  block,
  architecture,
  requirement,
  packet,
  radar,
  treemap,
);

// Diagrams come from the file being previewed, so no links or images, and
// keep the direction the source asks for.
export const MERMAID_RENDER_OPTIONS = Object.freeze({
  links: false,
  images: false,
  autoDirection: false,
});

// Pele colors follow the preview palette (index.html sets these on
// .mermaid-diagram), so switching themes recolors diagrams without a re-render.
export const MERMAID_THEME_VARS = Object.freeze({
  "--pele-bg": "var(--bg)",
  "--pele-fg": "var(--fg)",
  "--pele-muted": "var(--fg-muted)",
  "--pele-line": "var(--fg-muted)",
  "--pele-surface": "var(--bg-elevated)",
  "--pele-surface-alt": "var(--bg)",
  "--pele-border": "var(--border)",
  "--pele-accent": "var(--link)",
  "--pele-critical": "var(--danger)",
  "--pele-error": "var(--danger)",
});

const DROP_ELEMENTS = ["script", "foreignObject", "iframe", "object", "embed"];
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/;

function unsafeRef(value) {
  // Browsers ignore whitespace and control characters inside a scheme.
  const v = String(value)
    .replace(/&#(?:x0*(?:9|a|d)|0*(?:9|10|13));?/gi, "")
    .replace(/[\u0000-\u0020\u007f]+/g, "")
    .toLowerCase();
  if (/^(?:javascript|vbscript):/.test(v)) return true;
  if (/^data:/.test(v) && !SAFE_DATA_IMAGE.test(v)) return true;
  return false;
}

// A small defensive pass over Pele's output before it goes into the DOM (the
// webview has no CSP). Pele already escapes diagram text; this drops anything
// that could run script even if that ever slipped.
export function sanitizeSvg(svg) {
  let out = String(svg ?? "");
  for (const tag of DROP_ELEMENTS) {
    out = out
      .replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "")
      .replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "");
  }
  // Attributes inside tags: on* handlers and script/data refs.
  return out.replace(/<[a-zA-Z][^>]*>/g, (tag) =>
    tag.replace(
      /\s+([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
      (attr, name, dq, sq, uq) => {
        const lower = name.toLowerCase();
        if (/^on/.test(lower)) return "";
        if (/^(?:href|xlink:href|src|action|formaction)$/.test(lower)) {
          const value = dq ?? sq ?? uq ?? "";
          if (unsafeRef(value)) return "";
        }
        return attr;
      },
    ),
  );
}

// { svg } on success (sanitized), { error } otherwise. Never throws.
export function renderMermaid(source, options = {}) {
  try {
    const { svg } = render(String(source ?? ""), { ...options, ...MERMAID_RENDER_OPTIONS });
    return { svg: sanitizeSvg(svg) };
  } catch (err) {
    const message = err && typeof err.message === "string" ? err.message.trim() : "";
    return { error: message || "Could not render diagram" };
  }
}

function previewFont(root) {
  try {
    if (typeof globalThis.getComputedStyle !== "function") return undefined;
    const font = globalThis.getComputedStyle(root).fontFamily;
    return font ? String(font) : undefined;
  } catch {
    return undefined;
  }
}

function showError(el, source, message) {
  const doc = el.ownerDocument || globalThis.document;
  el.replaceChildren();
  const pre = doc.createElement("pre");
  pre.className = "mermaid-source";
  const code = doc.createElement("code");
  code.textContent = source;
  pre.appendChild(code);
  const note = doc.createElement("div");
  note.className = "mermaid-error";
  note.setAttribute("role", "note");
  note.textContent = `Mermaid: ${message}`;
  el.append(pre, note);
}

// Renders every .mermaid-diagram placeholder under root. A bad diagram shows
// its source and the error as text; it never stops the rest of the preview.
export function renderMermaidDiagrams(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const fontFamily = previewFont(root);
  const options = fontFamily ? { fontFamily } : {};
  for (const el of root.querySelectorAll(".mermaid-diagram")) {
    if (el.getAttribute("data-rendered") === "true") continue;
    const source = el.getAttribute("data-source") || "";
    try {
      const out = renderMermaid(source, options);
      if (out.svg) el.innerHTML = out.svg;
      else showError(el, source, out.error);
    } catch (err) {
      try {
        showError(el, source, (err && err.message) || "Could not render diagram");
      } catch {
        // Leave the fallback source block in place.
      }
    }
    el.setAttribute("data-rendered", "true");
  }
}

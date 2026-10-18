// Mermaid diagrams in the markdown preview, rendered with Pele (npm `pele`).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createDocument, decodeEntities } from "./helpers/dom.mjs";
import { loadHtml, root, srcDir } from "./helpers/source.mjs";

const MERMAID_JS = join(srcDir, "mermaid.js");
const FLOW = "flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]";

async function loadPreview() {
  return import("../src/preview.js");
}

async function loadMermaid() {
  assert.equal(existsSync(MERMAID_JS), true, "src/mermaid.js must exist");
  return import("../src/mermaid.js");
}

function previewRoot(html) {
  const doc = createDocument("<div id=\"r\"></div>");
  const el = doc.getElementById("r");
  el.innerHTML = html;
  return { doc, el };
}

test("package.json depends on pele", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.dependencies && pkg.dependencies.pele, "pele must be a runtime dependency");
});

test("a ```mermaid fence renders a diagram placeholder, not a code block", async () => {
  const { renderPreview } = await loadPreview();
  const html = renderPreview("# T\n\n```mermaid\n" + FLOW + "\n```\n");
  const { el } = previewRoot(html);
  const box = el.querySelector(".mermaid-diagram");
  assert.ok(box, "mermaid fence must become a .mermaid-diagram element");
  assert.equal(box.getAttribute("data-source"), FLOW, "data-source must carry the escaped source");
  assert.equal(el.querySelector("pre code.language-mermaid"), null, "no language-mermaid code block");
  assert.ok(box.getAttribute("data-line") != null, "placeholder keeps its source line for scroll sync");
});

test("mermaid source in the placeholder is escaped", async () => {
  const { renderPreview } = await loadPreview();
  const evil = 'flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B';
  const html = renderPreview("```mermaid\n" + evil + "\n```\n");
  assert.doesNotMatch(html, /<img/i, "raw tags in mermaid source must be escaped");
  const { el } = previewRoot(html);
  assert.equal(decodeEntities(el.querySelector(".mermaid-diagram").getAttribute("data-source")), evil);
});

test("other fences are unchanged", async () => {
  const { renderPreview } = await loadPreview();
  const html = renderPreview("```js\nconst a = 1;\n```\n\n```\nplain\n```\n");
  assert.equal(
    html,
    '<pre><code data-line="0" class="language-js">const a = 1;\n</code></pre>\n' +
      '<pre><code data-line="4">plain\n</code></pre>\n',
  );
  assert.doesNotMatch(html, /mermaid-diagram/);
});

test("mermaid.js uses pele/core with registered diagram types, not the lazy entry", () => {
  assert.equal(existsSync(MERMAID_JS), true, "src/mermaid.js must exist");
  const src = readFileSync(MERMAID_JS, "utf8");
  assert.match(src, /from\s+["']pele\/core["']/);
  assert.doesNotMatch(src, /["']pele\/lazy["']/);
  for (const type of ["flowchart", "sequence", "class", "state", "er", "gantt", "pie", "mindmap", "timeline"]) {
    assert.match(src, new RegExp(`from\\s+["']pele/diagrams/${type}["']`), `register ${type}`);
  }
});

test("renderMermaid turns a valid flowchart into an svg with links and images off", async () => {
  const { renderMermaid, MERMAID_RENDER_OPTIONS } = await loadMermaid();
  const out = renderMermaid(FLOW);
  assert.equal(out.error, undefined);
  assert.match(out.svg, /^<svg[\s>]/);
  assert.match(out.svg, /pele-flowchart/);
  assert.equal(MERMAID_RENDER_OPTIONS.links, false);
  assert.equal(MERMAID_RENDER_OPTIONS.images, false);
  assert.equal(MERMAID_RENDER_OPTIONS.autoDirection, false);
  const seq = renderMermaid("sequenceDiagram\n  Alice->>Bob: Hi");
  assert.match(seq.svg || "", /<svg/, "sequence diagrams are registered");
});

test("renderMermaid returns an error message for invalid source without throwing", async () => {
  const { renderMermaid } = await loadMermaid();
  let out;
  assert.doesNotThrow(() => {
    out = renderMermaid("flowchart LR\n  A[[--");
  });
  assert.equal(out.svg, undefined);
  assert.equal(typeof out.error, "string");
  assert.ok(out.error.length > 0);
});

test("sanitizeSvg strips scripts, foreignObject, on* handlers, and javascript: links", async () => {
  const { sanitizeSvg } = await loadMermaid();
  const dirty =
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
    "<script>alert(2)</script>" +
    '<foreignObject><div onclick="x()">hi</div></foreignObject>' +
    '<a href="javascript:alert(3)"><text>a</text></a>' +
    '<a xlink:href=" JaVaScRiPt:alert(4)"><text>b</text></a>' +
    '<rect ONMOUSEOVER=\'bad()\' width="1"/>' +
    '<image href="data:text/html,x"/>' +
    '<g class="pele-node"><text>ok</text></g></svg>';
  const clean = sanitizeSvg(dirty);
  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /foreignObject/i);
  assert.doesNotMatch(clean, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(clean, /javascript:/i);
  assert.doesNotMatch(clean, /data:text\/html/i);
  assert.match(clean, /<g class="pele-node"><text>ok<\/text><\/g>/);
  assert.match(clean, /<rect[^>]*width="1"/);
});

test("renderMermaidDiagrams fills placeholders with svg and shows errors as text", async () => {
  const { renderPreview } = await loadPreview();
  const { renderMermaidDiagrams } = await loadMermaid();
  const bad = "flowchart LR\n  A[[<b>x</b>";
  const html = renderPreview("```mermaid\n" + FLOW + "\n```\n\n```mermaid\n" + bad + "\n```\n");
  const { el } = previewRoot(html);
  assert.doesNotThrow(() => renderMermaidDiagrams(el));
  const [ok, broken] = el.querySelectorAll(".mermaid-diagram");
  assert.ok(ok.querySelector("svg"), "valid diagram gets an svg");
  assert.equal(broken.querySelector("svg"), null);
  assert.equal(broken.querySelector("b"), null, "error text must not be parsed as html");
  const err = broken.querySelector(".mermaid-error");
  assert.ok(err, "invalid diagram shows a .mermaid-error element");
  assert.ok(err.textContent.length > 0);
  assert.doesNotThrow(() => renderMermaidDiagrams(null));
});

test("pele theme variables map to LightMD preview tokens", async () => {
  const { MERMAID_THEME_VARS } = await loadMermaid();
  const expected = {
    "--pele-bg": "var(--bg)",
    "--pele-fg": "var(--fg)",
    "--pele-muted": "var(--fg-muted)",
    "--pele-line": "var(--fg-muted)",
    "--pele-surface": "var(--bg-elevated)",
    "--pele-border": "var(--border)",
    "--pele-accent": "var(--accent)",
    "--pele-critical": "var(--danger)",
    "--pele-error": "var(--danger)",
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(MERMAID_THEME_VARS[name], value, name);
  }
  const html = loadHtml();
  const rule = html.match(/\.mermaid-diagram\s*\{[^}]*\}/);
  assert.ok(rule, "index.html must style .mermaid-diagram");
  for (const [name, value] of Object.entries(MERMAID_THEME_VARS)) {
    assert.ok(rule[0].includes(`${name}: ${value}`), `index.html sets ${name}: ${value}`);
  }
});

test("the editor renders mermaid diagrams after inserting preview html", () => {
  const src = readFileSync(join(srcDir, "editor.js"), "utf8");
  assert.match(src, /from\s+["']\.\/mermaid\.js["']/);
  const insert = src.indexOf('insertAdjacentHTML("afterbegin", renderPreview(');
  const call = src.indexOf("renderMermaidDiagrams(", insert);
  assert.ok(insert >= 0 && call > insert, "renderMermaidDiagrams runs after the preview html is inserted");
});

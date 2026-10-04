import assert from "node:assert/strict";
import { test } from "node:test";
import { bindPreviewLinks, renderPreview } from "../src/preview.js";
import { clickAndAwait, createDocument } from "./helpers/dom.mjs";
import { buildTauriGlobals, createInvoke } from "./helpers/tauri.mjs";

function headingIds(html) {
  return [...html.matchAll(/<h[1-6]\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]);
}

// A preview pane in a fake document, plus the app globals a link click uses.
function mountPreview(markdown, { file = "docs/guide.md" } = {}) {
  const doc = createDocument('<div id="preview"><div id="preview-body"></div></div><p id="status-path"></p>');
  const body = doc.getElementById("preview-body");
  body.insertAdjacentHTML("afterbegin", renderPreview(markdown));
  bindPreviewLinks(body);
  const scrolled = [];
  for (const h of body.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    h.scrollIntoView = () => scrolled.push(h.getAttribute("id"));
  }
  const opened = [];
  const backend = createInvoke();
  const saved = {
    lightmdWorkspace: globalThis.lightmdWorkspace,
    lightmdOpenFile: globalThis.lightmdOpenFile,
    __TAURI__: globalThis.__TAURI__,
  };
  globalThis.lightmdWorkspace = { path: "/ws", relative: file };
  globalThis.lightmdOpenFile = async (relative) => {
    opened.push(relative);
  };
  globalThis.__TAURI__ = buildTauriGlobals(backend.invoke).__TAURI__;
  return {
    doc,
    body,
    scrolled,
    opened,
    backend,
    link: (href) => [...body.querySelectorAll("a")].find((a) => a.getAttribute("href") === href),
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

test("headings get unique, GitHub-style slug ids", () => {
  const html = renderPreview(
    "# Hello World\n\n## Hello World\n\n### Hello World\n\n# Café & Crème!\n\n## `code` and *em*\n",
  );
  assert.deepEqual(headingIds(html), [
    "user-content-hello-world",
    "user-content-hello-world-1",
    "user-content-hello-world-2",
    "user-content-café--crème",
    "user-content-code-and-em",
  ]);
});

test("heading ids restart for every render and never take an app element's id", () => {
  const md = "# Preview\n\n# Status path\n";
  const first = headingIds(renderPreview(md));
  assert.deepEqual(headingIds(renderPreview(md)), first, "ids must not keep counting across renders");
  assert.deepEqual(first, ["user-content-preview", "user-content-status-path"]);
});

test("a #fragment link scrolls to its heading inside the preview", async () => {
  const p = mountPreview(
    "[go](#second-part) [enc](#caf%C3%A9) [full](#user-content-intro)\n\n# Intro\n\n# Second part\n\n# Café\n",
  );
  try {
    await clickAndAwait(p.link("#second-part"));
    await clickAndAwait(p.link("#caf%C3%A9"));
    await clickAndAwait(p.link("#user-content-intro"));
    assert.deepEqual(p.scrolled, ["user-content-second-part", "user-content-café", "user-content-intro"]);
    assert.deepEqual(p.opened, [], "a fragment link must not open a file");
    assert.deepEqual(p.backend.opened, [], "nor the system browser");
  } finally {
    p.restore();
  }
});

test("a #fragment click is still prevented when no heading matches", async () => {
  const p = mountPreview("[nowhere](#nope)\n\n# Intro\n");
  try {
    const anchor = p.link("#nope");
    const allowed = anchor.dispatchEvent({ type: "click", bubbles: true, cancelable: true });
    assert.equal(allowed, false, "default navigation must be blocked");
    assert.deepEqual(p.scrolled, []);
  } finally {
    p.restore();
  }
});

test("relative .md/.html links open the workspace file, resolved against the note", async () => {
  const p = mountPreview(
    [
      "[a](other.md)",
      "[b](../up.md)",
      "[c](/root.md)",
      "[d](sub/page.html#intro)",
      "[e](<my note.md>)",
      "[f](./Deep/Thing.HTM)",
    ].join(" "),
  );
  try {
    for (const href of ["other.md", "../up.md", "/root.md", "sub/page.html#intro", "my%20note.md", "./Deep/Thing.HTM"]) {
      await clickAndAwait(p.link(href));
    }
    assert.deepEqual(p.opened, [
      "docs/other.md",
      "up.md",
      "root.md",
      "docs/sub/page.html",
      "docs/my note.md",
      "docs/Deep/Thing.HTM",
    ]);
    assert.deepEqual(p.backend.opened, [], "workspace links must not go to the system browser");
  } finally {
    p.restore();
  }
});

test("links that leave the workspace or aren't documents open nothing", async () => {
  const p = mountPreview("[a](../../escape.md) [b](pic.png) [c](mailto:x@y.z) [d](notes.txt)");
  try {
    for (const href of ["../../escape.md", "pic.png", "mailto:x@y.z", "notes.txt"]) {
      const anchor = p.link(href);
      assert.ok(anchor, `fixture must render a link for ${href}`);
      await clickAndAwait(anchor);
    }
    assert.deepEqual(p.opened, []);
    assert.deepEqual(p.backend.opened, []);
  } finally {
    p.restore();
  }
});

test("a link to another note's #section scrolls there once the note is open", async () => {
  const p = mountPreview("[next](next.md#details)");
  try {
    globalThis.lightmdOpenFile = async (relative) => {
      p.opened.push(relative);
      p.body.replaceChildren();
      p.body.insertAdjacentHTML("afterbegin", renderPreview("# Top\n\n## Details\n"));
      for (const h of p.body.querySelectorAll("h1, h2")) {
        h.scrollIntoView = () => p.scrolled.push(h.getAttribute("id"));
      }
    };
    await clickAndAwait(p.link("next.md#details"));
    assert.deepEqual(p.opened, ["docs/next.md"]);
    assert.deepEqual(p.scrolled, ["user-content-details"]);
  } finally {
    p.restore();
  }
});

test("external https links still go to the system browser", async () => {
  const p = mountPreview("[site](https://example.com/page)");
  try {
    await clickAndAwait(p.link("https://example.com/page"));
    assert.deepEqual(p.backend.opened, ["https://example.com/page"]);
    assert.deepEqual(p.opened, []);
  } finally {
    p.restore();
  }
});

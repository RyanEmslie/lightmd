import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPreview, resolvePreviewImage, rewritePreviewImages } from "../src/preview.js";
import { createDocument } from "./helpers/dom.mjs";
import { buildTauriGlobals, createInvoke } from "./helpers/tauri.mjs";

// markdown-it percent-encodes image URLs (spaces, non-ASCII), so the preview
// must decode them before asking the backend for a workspace-relative file.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let wsSeq = 0;

async function renderImage(markdown, { file = "docs/guide.md", files = {} } = {}) {
  const root = `/tmp/ws-img-paths-${++wsSeq}`;
  const backend = createInvoke({ root, files });
  const previous = globalThis.__TAURI__;
  globalThis.__TAURI__ = buildTauriGlobals(backend.invoke).__TAURI__;
  try {
    const doc = createDocument('<div id="preview-body"></div>');
    const body = doc.getElementById("preview-body");
    body.insertAdjacentHTML("afterbegin", renderPreview(markdown));
    const img = body.querySelector("img");
    const rendered = img.getAttribute("src");
    await rewritePreviewImages(body, root, file);
    const reads = backend.invokes
      .filter((call) => call.cmd === "read_workspace_image")
      .map((call) => call.args.relative);
    return { rendered, src: img.getAttribute("src"), reads };
  } finally {
    globalThis.__TAURI__ = previous;
  }
}

const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

const cases = [
  ["a space via <...>", "![](<my image.png>)", "docs/my image.png"],
  ["a space via %20", "![](my%20image.png)", "docs/my image.png"],
  ["a non-ASCII name", "![](café.png)", "docs/café.png"],
  ["a parent folder", "![](../assets/a.png)", "assets/a.png"],
  ["a leading / (workspace root)", "![](/assets/a.png)", "assets/a.png"],
  ["a #fragment", "![](a.png#icon)", "docs/a.png"],
  ["a ?query", "![](diagram.png?raw=true)", "docs/diagram.png"],
  ["an encoded # in the name", "![](<issue #4.png>)", "docs/issue #4.png"],
];

for (const [label, markdown, relative] of cases) {
  test(`an image with ${label} loads ${relative} from the workspace`, async () => {
    const { rendered, src, reads } = await renderImage(markdown, {
      files: { [relative]: { bytes: PNG } },
    });
    assert.deepEqual(reads, [relative], `markdown-it src ${rendered} must map to ${relative}`);
    assert.equal(src, dataUrl, "the decoded file's bytes must become the img src");
  });
}

test("a literal % in a name round-trips through markdown-it's encoding", async () => {
  const { reads, src } = await renderImage("![](bad%ZZname.png)", {
    files: { "docs/bad%ZZname.png": { bytes: PNG } },
  });
  assert.deepEqual(reads, ["docs/bad%ZZname.png"]);
  assert.equal(src, dataUrl);
});

test("encoded dots and slashes cannot climb out of the workspace", async () => {
  for (const markdown of ["![](%2E%2E/%2E%2E/x.png)", "![](..%2F..%2Fx.png)", "![](a%2F..%2F..%2F..%2Fx.png)"]) {
    const { reads } = await renderImage(markdown, { file: "note.md" });
    assert.deepEqual(reads, [], `${markdown} must not reach the backend`);
  }
});

test("resolvePreviewImage decodes the same way", () => {
  const previous = globalThis.__TAURI__;
  delete globalThis.__TAURI__;
  try {
    assert.equal(resolvePreviewImage("my%20image.png", "/ws", "docs/guide.md"), "/ws/docs/my image.png");
    assert.equal(resolvePreviewImage("/assets/a.png?x=1", "/ws", "docs/guide.md"), "/ws/assets/a.png");
    assert.equal(
      resolvePreviewImage("bad%ZZname.png", "/ws", "docs/guide.md"),
      "/ws/docs/bad%ZZname.png",
      "a malformed %-escape is used as written instead of throwing",
    );
  } finally {
    if (previous !== undefined) globalThis.__TAURI__ = previous;
  }
});

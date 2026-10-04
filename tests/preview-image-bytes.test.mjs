import assert from "node:assert/strict";
import { test } from "node:test";
import { rewritePreviewImages } from "../src/preview.js";

// read_workspace_image returns a raw tauri::ipc::Response, which the webview
// hands to JS as an ArrayBuffer. Older backends and test fakes return a
// Uint8Array or a plain number[]; all three must become the same data: URL.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff];

function fakeImg(src) {
  const attrs = new Map([["src", src]]);
  return {
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
  };
}

function fakeRoot(imgs) {
  return {
    querySelectorAll(sel) {
      return sel === "img" ? imgs : [];
    },
  };
}

async function rewriteWith(response, { workspace, relative }) {
  const calls = [];
  const previous = globalThis.__TAURI__;
  globalThis.__TAURI__ = {
    core: {
      async invoke(cmd, args) {
        calls.push({ cmd, args });
        return response;
      },
    },
  };
  try {
    const img = fakeImg(relative);
    await rewritePreviewImages(fakeRoot([img]), workspace, "note.md");
    return { src: img.getAttribute("src"), calls };
  } finally {
    globalThis.__TAURI__ = previous;
  }
}

function expectedDataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

const shapes = [
  ["ArrayBuffer", () => Uint8Array.from(PNG).buffer],
  ["Uint8Array", () => Uint8Array.from(PNG)],
  ["number[]", () => [...PNG]],
  [
    "Uint8Array view with an offset",
    () => {
      const padded = Uint8Array.from([0xaa, 0xbb, ...PNG, 0xcc]);
      return padded.subarray(2, 2 + PNG.length);
    },
  ],
  [
    "DataView with an offset",
    () => {
      const padded = Uint8Array.from([0xaa, 0xbb, ...PNG, 0xcc]);
      return new DataView(padded.buffer, 2, PNG.length);
    },
  ],
];

for (const [label, make] of shapes) {
  test(`read_workspace_image bytes as ${label} become a PNG data: URL`, async () => {
    const workspace = `/tmp/ws-bytes-${label.replace(/\W+/g, "-")}`;
    const { src, calls } = await rewriteWith(make(), { workspace, relative: "pic.png" });
    assert.deepEqual(
      calls,
      [{ cmd: "read_workspace_image", args: { path: workspace, relative: "pic.png" } }],
      "the preview must ask the backend for the workspace image",
    );
    assert.equal(
      src,
      expectedDataUrl("image/png", PNG),
      `${label} bytes must become a data:image/png URL with the same bytes`,
    );
  });
}

test("read_workspace_image ArrayBuffer keeps the mime type of the file extension", async () => {
  const cases = [
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["anim.gif", "image/gif"],
    ["pic.webp", "image/webp"],
    ["icon.svg", "image/svg+xml"],
  ];
  for (const [relative, mime] of cases) {
    const { src } = await rewriteWith(Uint8Array.from(PNG).buffer, {
      workspace: "/tmp/ws-bytes-mime",
      relative,
    });
    assert.equal(src, expectedDataUrl(mime, PNG), `${relative} must use ${mime}`);
  }
});

test("an unrecognised response leaves the img src alone", async () => {
  const { src } = await rewriteWith(
    { not: "bytes" },
    { workspace: "/tmp/ws-bytes-unknown", relative: "pic.png" },
  );
  assert.equal(src, "pic.png", "unknown shapes must not produce a broken data: URL");
});

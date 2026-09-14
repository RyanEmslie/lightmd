import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderPreview,
  rewritePreviewImages,
  resolvePreviewImage,
} from "../src/preview.js";

test("renderPreview does not emit http(s) or protocol-relative image srcs", () => {
  const html = renderPreview(
    "![remote](https://evil.com/x.png)\n![proto](//evil.com/y.png)\n![ok](./pic.png)\n",
  );
  assert.equal(
    /src=["']https?:/i.test(html),
    false,
    "https image src must not appear in preview HTML",
  );
  assert.equal(
    /src=["']\/\//.test(html),
    false,
    "protocol-relative image src must not appear in preview HTML",
  );
  assert.match(html, /pic\.png/);
});

test("rewritePreviewImages strips leftover remote srcs", async () => {
  const removed = [];
  const imgs = [
    {
      getAttribute(name) {
        return name === "src" ? "https://evil.com/x.png" : null;
      },
      setAttribute() {},
      removeAttribute(name) {
        removed.push(name);
      },
    },
    {
      getAttribute(name) {
        return name === "src" ? "./pic.png" : null;
      },
      setAttribute() {},
      removeAttribute() {},
    },
  ];
  const root = {
    querySelectorAll(sel) {
      return sel === "img" ? imgs : [];
    },
  };
  await rewritePreviewImages(root, "/tmp/ws", "note.md");
  assert.ok(removed.includes("src"), "remote img src must be removed");
});

test("resolvePreviewImage does not pass through remote http(s) srcs", () => {
  assert.equal(resolvePreviewImage("https://evil.com/x.png", "/tmp/ws"), "");
  assert.equal(resolvePreviewImage("//evil.com/x.png", "/tmp/ws"), "");
  assert.match(String(resolvePreviewImage("./pic.png", "/tmp/ws")), /pic\.png/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import * as preview from "../src/preview.js";

const { rewritePreviewImages } = preview;

// Every keystroke re-renders the preview and re-resolves its images, so the
// image cache decides how much IPC and memory typing costs.

function fakeImg(src) {
  const attrs = new Map([["src", src]]);
  return {
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
  };
}

function fakeRoot(imgs) {
  return { querySelectorAll: (sel) => (sel === "img" ? imgs : []) };
}

function withInvoke(invoke, fn) {
  const previous = globalThis.__TAURI__;
  globalThis.__TAURI__ = { core: { invoke } };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.__TAURI__ = previous;
    });
}

function dataUrl(bytes) {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

let wsSeq = 0;
const freshWorkspace = () => `/tmp/ws-img-cache-${++wsSeq}`;

test("renders during one pending read share it instead of each reading the file", async () => {
  const workspace = freshWorkspace();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withInvoke(
    async () => {
      calls += 1;
      await gate;
      return Uint8Array.from([1, 2, 3]).buffer;
    },
    async () => {
      const imgs = Array.from({ length: 10 }, () => fakeImg("big.png"));
      const renders = imgs.map((img) => rewritePreviewImages(fakeRoot([img]), workspace, "doc.md"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      release();
      await Promise.all(renders);
      assert.equal(calls, 1, "10 keystrokes during one pending read must make one read_workspace_image call");
      // Only the newest render applies its result; older renders' DOM is gone in the app.
      assert.equal(imgs.at(-1).getAttribute("src"), dataUrl([1, 2, 3]));
    },
  );
});

test("a missing image is not re-read on every render until its miss expires", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const workspace = freshWorkspace();
  let calls = 0;
  await withInvoke(
    async () => {
      calls += 1;
      throw "No such file or directory (os error 2)";
    },
    async () => {
      for (let i = 0; i < 10; i++) {
        await rewritePreviewImages(fakeRoot([fakeImg("missing.png")]), workspace, "doc.md");
      }
      assert.equal(calls, 1, "a miss must be remembered between renders");
      t.mock.timers.tick(preview.previewImageCache.missTtlMs + 1);
      await rewritePreviewImages(fakeRoot([fakeImg("missing.png")]), workspace, "doc.md");
      assert.equal(calls, 2, "after the miss TTL the file is tried again (it may exist now)");
    },
  );
});

test("invalidatePreviewImages makes the next render re-read changed files, even on the same DOM", async () => {
  assert.equal(typeof preview.invalidatePreviewImages, "function", "preview.js must export invalidatePreviewImages");
  const workspace = freshWorkspace();
  let version = 1;
  let calls = 0;
  await withInvoke(
    async () => {
      calls += 1;
      return Uint8Array.from([version]).buffer;
    },
    async () => {
      const img = fakeImg("chart.png");
      const root = fakeRoot([img]);
      await rewritePreviewImages(root, workspace, "doc.md");
      assert.equal(img.getAttribute("src"), dataUrl([1]));
      await rewritePreviewImages(fakeRoot([fakeImg("chart.png")]), workspace, "doc.md");
      assert.equal(calls, 1, "a cached image is not re-read");

      version = 2; // chart.png is re-exported on disk
      preview.invalidatePreviewImages();
      await rewritePreviewImages(root, workspace, "doc.md");
      assert.equal(calls, 2, "after invalidation the image is read again");
      assert.equal(img.getAttribute("src"), dataUrl([2]), "the rewritten img must pick up the new bytes");
    },
  );
});

test("invalidating while a read is in flight does not start a second read", async () => {
  const workspace = freshWorkspace();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withInvoke(
    async () => {
      calls += 1;
      await gate;
      return Uint8Array.from([7]).buffer;
    },
    async () => {
      const first = rewritePreviewImages(fakeRoot([fakeImg("a.png")]), workspace, "doc.md");
      await new Promise((resolve) => setTimeout(resolve, 1));
      preview.invalidatePreviewImages();
      const img = fakeImg("a.png");
      const second = rewritePreviewImages(fakeRoot([img]), workspace, "doc.md");
      release();
      await Promise.all([first, second]);
      assert.equal(calls, 1, "a read already in flight sees the file as it is now");
      assert.equal(img.getAttribute("src"), dataUrl([7]));
    },
  );
});

test("the cache is bounded and evicts the least recently used image first", async () => {
  const limits = preview.previewImageCache;
  assert.ok(limits && Number.isFinite(limits.maxChars), "preview.js must export previewImageCache.maxChars");
  const saved = limits.maxChars;
  const workspace = freshWorkspace();
  const reads = [];
  const bytes = new Uint8Array(300); // ~400 base64 chars per data URL
  const one = dataUrl(bytes).length;
  limits.maxChars = one * 2 + 10; // room for two images
  try {
    await withInvoke(
      async (_cmd, args) => {
        reads.push(args.relative);
        return bytes.slice().buffer;
      },
      async () => {
        const show = (name) => rewritePreviewImages(fakeRoot([fakeImg(name)]), workspace, "doc.md");
        await show("a.png");
        await show("b.png");
        await show("a.png"); // a is now the most recently used
        await show("c.png"); // evicts b, not a
        reads.length = 0;
        await show("a.png");
        await show("c.png");
        assert.deepEqual(reads, [], "a and c must still be cached");
        await show("b.png");
        assert.deepEqual(reads, ["b.png"], "b was least recently used, so it was evicted");
      },
    );
  } finally {
    limits.maxChars = saved;
  }
});

test("an image bigger than the whole cache is shown but not kept", async () => {
  const limits = preview.previewImageCache;
  const saved = limits.maxChars;
  const workspace = freshWorkspace();
  let calls = 0;
  limits.maxChars = 50;
  try {
    await withInvoke(
      async () => {
        calls += 1;
        return new Uint8Array(300).buffer;
      },
      async () => {
        const img = fakeImg("huge.png");
        await rewritePreviewImages(fakeRoot([img]), workspace, "doc.md");
        assert.match(img.getAttribute("src"), /^data:image\/png;base64,/);
        await rewritePreviewImages(fakeRoot([fakeImg("huge.png")]), workspace, "doc.md");
        assert.equal(calls, 2, "an image larger than maxChars is not cached");
      },
    );
  } finally {
    limits.maxChars = saved;
  }
});

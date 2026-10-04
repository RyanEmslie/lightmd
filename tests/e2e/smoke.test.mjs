import assert from "node:assert/strict";
import { test } from "node:test";
import { launchApp } from "./helpers/app.mjs";

test("the app boots in WebKit with no console errors", async () => {
  const app = await launchApp();
  try {
    assert.equal(await app.page.title(), "LightMD");
    assert.equal(
      await app.page.locator("#editor-view .cm-editor .cm-content").count(),
      1,
      "editor.js must mount CodeMirror in #editor-view",
    );
    await app.settle();
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("open folder, then a file: CodeMirror shows its text and the preview renders it", async () => {
  const app = await launchApp({
    files: { "note.md": "# Hello WebKit\n\nSome *body* text.\n", "notes/deep.md": "deep\n" },
  });
  try {
    await app.openFolder();
    assert.ok(
      await app.page.locator('#file-list li[data-path="note.md"]').isVisible(),
      "the explorer must list the folder",
    );
    await app.openFile("note.md");
    assert.equal(await app.editorText(), "# Hello WebKit\n\nSome *body* text.\n");
    await app.page.locator(".cm-content", { hasText: "Hello WebKit" }).waitFor();
    assert.equal(await app.page.locator("#preview-body h1").textContent(), "Hello WebKit");
    assert.equal(await app.page.locator("#preview-body em").textContent(), "body");
    assert.equal(await app.page.locator("#status-path").textContent(), "note.md");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("typing in CodeMirror marks the file dirty and autosave writes it", async () => {
  const app = await launchApp({ files: { "note.md": "# Draft\n" }, autosaveDelay: 300 });
  try {
    await app.openFolder();
    await app.openFile("note.md");
    assert.equal(await app.isDirty(), false, "a freshly opened file is clean");
    // Record what the dirty dot looks like the moment it appears.
    await app.page.evaluate(() => {
      const dot = document.getElementById("dirty");
      const probe = document.createElement("span");
      probe.style.background = "var(--accent)";
      document.body.append(probe);
      window.__dirtySeen = null;
      new MutationObserver(() => {
        if (dot.hidden || window.__dirtySeen) return;
        window.__dirtySeen = {
          background: getComputedStyle(dot).backgroundColor,
          accent: getComputedStyle(probe).backgroundColor,
          width: dot.getBoundingClientRect().width,
        };
      }).observe(dot, { attributes: true });
    });

    await app.type("\nmore words");

    const seen = await app.waitFor(() => app.page.evaluate(() => window.__dirtySeen), {
      message: "the dirty dot to show",
    });
    assert.ok(seen.width > 0, "the dirty dot must be visible, not just un-hidden");
    assert.equal(seen.background, seen.accent, "the dirty dot must use the --accent colour");

    const write = await app.waitForWrite("note.md");
    assert.equal(write.contents, "# Draft\n\nmore words");
    assert.equal(write.path, app.root, "autosave must write under the open folder");
    assert.equal(app.files.get("note.md"), "# Draft\n\nmore words");
    await app.waitFor(async () => !(await app.isDirty()), { message: "autosave to clear dirty" });
    assert.match(await app.previewText(), /more words/, "live preview must follow the edit");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

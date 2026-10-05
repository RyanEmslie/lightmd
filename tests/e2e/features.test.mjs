// Launcher, recent folders, outline, scroll sync and live reload, driven in
// WebKit against the real bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp } from "./helpers/app.mjs";

const LONG = Array.from(
  { length: 12 },
  (_, i) => `## Section ${i + 1}\n\n${"Some paragraph text that fills the page. ".repeat(12)}\n\n`,
).join("");

test("a path given on the command line opens instead of the last session", async () => {
  const app = await launchApp({
    files: { "note.md": "# From the command line\n", "old.md": "# Old session\n" },
    storage: { "lightmd.session": { lastFolder: "/tmp/lightmd-e2e", lastFile: "old.md" } },
    launchTarget: { root: "/tmp/lightmd-e2e", relative: "note.md" },
  });
  try {
    await app.waitFor(async () => (await app.editorText()).includes("From the command line"));
    assert.ok(await app.page.isVisible('#editor-tabs [data-path="note.md"]'), "the named file has a tab");
    assert.ok(!(await app.page.isVisible('#editor-tabs [data-path="old.md"]')), "the old session stays closed");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("opened folders are listed under Recent folders and reopen from there", async () => {
  const app = await launchApp({
    files: { "a.md": "# A\n" },
    workspaces: { "/tmp/other": { "b.md": "# B\n" } },
  });
  try {
    assert.equal(await app.page.isVisible("#recent-empty"), false, "nothing recent yet");
    await app.openFolder();
    await app.openFolder("/tmp/other");
    const stored = await app.page.evaluate(() => JSON.parse(localStorage.getItem("lightmd.recentFolders")));
    assert.deepEqual(stored, ["/tmp/other", "/tmp/lightmd-e2e"]);

    await app.page.click("#recent-folders");
    const items = await app.page.$$eval("#recent-menu button[data-folder]", (els) =>
      els.map((el) => el.dataset.folder),
    );
    assert.deepEqual(items, ["/tmp/other", "/tmp/lightmd-e2e"]);
    await app.page.click('#recent-menu button[data-folder="/tmp/lightmd-e2e"]');
    await app.waitFor(() => app.page.isVisible('#file-list li[data-path="a.md"]'));
    assert.equal(await app.page.isVisible("#recent-menu"), false, "the menu closes after a pick");

    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("with no folder open, the explorer offers the recent folders", async () => {
  const app = await launchApp({
    files: { "a.md": "# A\n" },
    storage: { "lightmd.recentFolders": ["/tmp/lightmd-e2e"], "lightmd.session": { restore: false } },
  });
  try {
    await app.waitFor(() => app.page.isVisible("#recent-empty"));
    await app.page.click('#recent-empty button[data-folder="/tmp/lightmd-e2e"]');
    await app.waitFor(() => app.page.isVisible('#file-list li[data-path="a.md"]'));
    assert.equal(await app.page.isVisible("#recent-empty"), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("the outline lists the headings and jumps to one when clicked", async () => {
  const app = await launchApp({ files: { "note.md": "# Title\n\n" + LONG } });
  try {
    await app.openFolder();
    await app.openFile("note.md");
    await app.page.evaluate(() => window.lightmdEditor.flushPreview());
    const items = await app.page.$$eval("#outline-list button", (els) =>
      els.map((el) => [el.textContent.trim(), el.dataset.level]),
    );
    assert.equal(items.length, 13);
    assert.deepEqual(items[0], ["Title", "1"]);
    assert.deepEqual(items[12], ["Section 12", "2"]);

    await app.page.click('#outline-list button:text-is("Section 10")');
    await app.settle();
    const state = await app.page.evaluate(() => {
      const view = window.lightmdEditor.view;
      const line = view.state.doc.lineAt(view.state.selection.main.head).text;
      const body = document.getElementById("preview-body");
      const heading = document.getElementById("user-content-section-10");
      const offset = heading.getBoundingClientRect().top - body.getBoundingClientRect().top;
      return { line, offset };
    });
    assert.equal(state.line, "## Section 10");
    assert.ok(Math.abs(state.offset) < 40, `preview heading should be at the top, was ${state.offset}px`);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("scrolling the editor scrolls the preview to the same place", async () => {
  const app = await launchApp({ files: { "note.md": LONG } });
  try {
    await app.openFolder();
    await app.openFile("note.md");
    await app.page.evaluate(() => window.lightmdEditor.flushPreview());
    await app.page.evaluate(() => {
      // CodeMirror's own scroll, so wrapped lines are measured, not estimated.
      const view = window.lightmdEditor.view;
      const line = view.state.doc.line(view.state.doc.toString().split("\n").indexOf("## Section 8") + 1);
      view.dispatch({ effects: view.constructor.scrollIntoView(line.from, { y: "start" }) });
    });
    await app.waitFor(async () => {
      const off = await app.page.evaluate(() => {
        const body = document.getElementById("preview-body");
        const h = document.getElementById("user-content-section-8");
        return h.getBoundingClientRect().top - body.getBoundingClientRect().top;
      });
      return Math.abs(off) < 60;
    });

    await app.page.click("#settings-open");
    await app.page.uncheck("#settings-sync-scroll");
    await app.page.click("#settings-close");
    const before = await app.page.evaluate(() => document.getElementById("preview-body").scrollTop);
    await app.page.evaluate(() => {
      window.lightmdEditor.view.scrollDOM.scrollTop = 0;
    });
    await app.settle();
    const after = await app.page.evaluate(() => document.getElementById("preview-body").scrollTop);
    assert.equal(after, before, "with sync off the preview stays put");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("a clean open file reloads when another program changes it", async () => {
  const app = await launchApp({ files: { "note.md": "# Before\n" } });
  try {
    await app.openFolder();
    await app.openFile("note.md");
    app.files.set("note.md", "# After\n");
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.waitFor(async () => (await app.editorText()).includes("After"));
    assert.equal(await app.isDirty(), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bootApp } from "./helpers/app.mjs";

// Each tab is its own document: it remembers the folder it came from, closing
// one never leaks its text into another, and racing opens settle on one tab.

function type(rt, text) {
  const buffer = rt.el("editor-buffer");
  buffer.value = text;
  buffer.dispatchEvent({ type: "input", bubbles: true });
}

function tabEls(rt) {
  return rt.el("editor-tabs").querySelectorAll('[role="tab"]');
}

function tabNames(rt) {
  return tabEls(rt).map((el) => el.dataset.relative || "(untitled)");
}

function activeTabName(rt) {
  const el = tabEls(rt).find((t) => t.getAttribute("aria-selected") === "true");
  return el ? el.dataset.relative || "(untitled)" : null;
}

function tabEl(rt, relative) {
  const el = tabEls(rt).find((t) => (t.dataset.relative || "") === relative);
  assert.ok(el, `no tab for ${JSON.stringify(relative)} in ${JSON.stringify(tabNames(rt))}`);
  return el;
}

function clickTab(rt, relative) {
  tabEl(rt, relative).querySelector(".tab-name").click();
}

async function closeTab(rt, relative) {
  await rt.clickAndAwait(tabEl(rt, relative).querySelector(".tab-close"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Save As outside the workspace keeps the other tabs on their own files", () => {
  const A = "/ws/A";
  const ELSEWHERE = "/elsewhere";

  function boot(options = {}) {
    return bootApp({
      folderPath: A,
      files: { "a.md": "A original\n" },
      workspaces: { [ELSEWHERE]: { files: { "a.md": "elsewhere's own a.md\n" } } },
      dialog: { save: `${ELSEWHERE}/copy.md` },
      ...options,
    });
  }

  async function saveDraftElsewhere(rt) {
    await rt.win.lightmdOpenFolder(A);
    await rt.win.lightmdOpenFile("a.md");
    await rt.win.lightmdNewNote();
    type(rt, "draft text");
    assert.equal(await rt.win.lightmdSaveAs(), true, "precondition: Save As succeeds");
    assert.equal(rt.backend.read(ELSEWHERE, "copy.md"), "draft text");
  }

  test("the explorer follows the saved file's folder, but a.md's tab still saves to /ws/A", async () => {
    const rt = boot();
    try {
      await saveDraftElsewhere(rt);
      assert.equal(rt.win.lightmdWorkspace.path, ELSEWHERE, "the explorer switches folder");
      clickTab(rt, "a.md");
      assert.equal(rt.el("editor-buffer").value, "A original\n");
      type(rt, "A original\nplus edit\n");
      await rt.win.lightmdSave();
      assert.equal(rt.backend.read(A, "a.md"), "A original\nplus edit\n", "the edit reaches the original");
      assert.equal(
        rt.backend.read(ELSEWHERE, "a.md"),
        "elsewhere's own a.md\n",
        "the new folder's a.md must not be overwritten",
      );
      assert.equal(rt.writes.at(-1).path, A);
    } finally {
      rt.cleanup();
    }
  });

  test("autosave of the old tab writes under its own folder", async () => {
    const rt = boot({ realAutosave: true });
    const delayBefore = rt.autosave.delay;
    try {
      rt.autosave.delay = 1;
      await saveDraftElsewhere(rt);
      clickTab(rt, "a.md");
      type(rt, "autosaved edit\n");
      await delay(20);
      assert.equal(rt.backend.read(A, "a.md"), "autosaved edit\n");
      assert.equal(rt.backend.read(ELSEWHERE, "a.md"), "elsewhere's own a.md\n");
    } finally {
      rt.autosave.delay = delayBefore;
      rt.cleanup();
    }
  });

  test("opening the new folder's a.md is a separate tab from /ws/A's a.md", async () => {
    const rt = boot();
    try {
      await saveDraftElsewhere(rt);
      await rt.win.lightmdOpenFile("a.md");
      assert.equal(rt.el("editor-buffer").value, "elsewhere's own a.md\n");
      assert.equal(tabEls(rt).filter((t) => t.dataset.relative === "a.md").length, 2);
    } finally {
      rt.cleanup();
    }
  });
});

describe("closing the active tab never shows or stores the wrong text", () => {
  test("[draft, a, b*] close b: the draft keeps its text", async () => {
    const rt = bootApp({ files: { "a.md": "AAA\n", "b.md": "BBB\n" } });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      await rt.win.lightmdNewNote();
      type(rt, "MY PRECIOUS DRAFT");
      await rt.win.lightmdOpenFile("a.md");
      await rt.win.lightmdOpenFile("b.md");
      await closeTab(rt, "b.md");
      assert.deepEqual(tabNames(rt), ["(untitled)", "a.md"]);
      assert.equal(activeTabName(rt), "a.md");
      assert.equal(rt.el("editor-buffer").value, "AAA\n", "a.md's text is shown");
      clickTab(rt, "");
      assert.equal(rt.el("editor-buffer").value, "MY PRECIOUS DRAFT", "b's text must not replace the draft");
    } finally {
      rt.cleanup();
    }
  });

  test("[a*, draft] close a: the draft is shown, not a's text under the draft's tab", async () => {
    const rt = bootApp({ files: { "a.md": "AAA file body\n" } });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      await rt.win.lightmdOpenFile("a.md");
      await rt.win.lightmdNewNote();
      type(rt, "MY DRAFT");
      clickTab(rt, "a.md");
      assert.equal(rt.el("editor-buffer").value, "AAA file body\n");
      await closeTab(rt, "a.md");
      assert.deepEqual(tabNames(rt), ["(untitled)"]);
      assert.equal(activeTabName(rt), "(untitled)");
      assert.equal(rt.el("editor-buffer").value, "MY DRAFT");
      assert.equal(rt.el("status-path").textContent, "");
      assert.equal(rt.win.lightmdWorkspace.relative, null);
      assert.equal(rt.el("dirty").hidden, false, "the draft is still unsaved");
    } finally {
      rt.cleanup();
    }
  });
});

describe("racing opens settle on one tab and the last click", () => {
  test("opening the same file twice during a slow read makes one tab", async () => {
    const rt = bootApp({
      files: { "a.md": "# A\n" },
      onInvoke: async (cmd) => {
        if (cmd === "read_workspace_file") await delay(20);
      },
    });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      await Promise.all([rt.win.lightmdOpenFile("a.md"), rt.win.lightmdOpenFile("a.md")]);
      assert.deepEqual(tabNames(rt), ["a.md"]);
      assert.equal(rt.invokes.filter((i) => i.cmd === "read_workspace_file").length, 1);
    } finally {
      rt.cleanup();
    }
  });

  test("a slow read that finishes after a later click does not take over the editor", async () => {
    const rt = bootApp({
      files: { "slow.md": "# SLOW\n", "fast.md": "# FAST\n" },
      onInvoke: async (cmd, args) => {
        if (cmd === "read_workspace_file") await delay(args.relative === "slow.md" ? 60 : 5);
      },
    });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      const slow = rt.win.lightmdOpenFile("slow.md");
      await delay(10);
      const fast = rt.win.lightmdOpenFile("fast.md");
      await Promise.all([slow, fast]);
      assert.equal(rt.el("editor-buffer").value, "# FAST\n");
      assert.equal(rt.win.lightmdWorkspace.relative, "fast.md");
      assert.equal(rt.el("status-path").textContent, "fast.md");
      assert.equal(activeTabName(rt), "fast.md");
      assert.equal(new Set(tabNames(rt)).size, tabNames(rt).length, "no duplicate tabs");
    } finally {
      rt.cleanup();
    }
  });
});

describe("events and buffers other modules rely on", () => {
  function record(rt, type) {
    const seen = [];
    rt.win.addEventListener(type, (event) => seen.push(event.detail));
    return seen;
  }

  test("lightmd:workspace-changed fires on Open Folder and on a Save As that switches folder", async () => {
    const rt = bootApp({
      files: { "a.md": "A" },
      workspaces: { "/other": {} },
      dialog: { save: "/other/new.md" },
    });
    try {
      const seen = record(rt, "lightmd:workspace-changed");
      await rt.win.lightmdOpenFolder(rt.folderPath);
      assert.deepEqual(seen, [{ root: rt.folderPath }]);
      await rt.win.lightmdNewNote();
      type(rt, "x");
      await rt.win.lightmdSaveAs();
      assert.deepEqual(seen, [{ root: rt.folderPath }, { root: "/other" }]);
    } finally {
      rt.cleanup();
    }
  });

  test("lightmd:document-loaded fires for open, switch, new note and close-tab activation", async () => {
    const rt = bootApp({ files: { "a.md": "A", "b.md": "B" } });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      const seen = record(rt, "lightmd:document-loaded");
      const root = rt.folderPath;
      await rt.win.lightmdOpenFile("a.md");
      await rt.win.lightmdOpenFile("b.md");
      clickTab(rt, "a.md");
      await rt.win.lightmdNewNote();
      await closeTab(rt, "");
      assert.deepEqual(seen, [
        { root, relative: "a.md" },
        { root, relative: "b.md" },
        { root, relative: "a.md" },
        { root, relative: null },
        { root, relative: "b.md" },
      ]);
    } finally {
      rt.cleanup();
    }
  });

  test("lightmdGetOpenBuffers lists the open file tabs with their live text", async () => {
    const rt = bootApp({ files: { "a.md": "A", "b.md": "B" } });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      await rt.win.lightmdOpenFile("a.md");
      await rt.win.lightmdOpenFile("b.md");
      await rt.win.lightmdNewNote();
      type(rt, "untitled is not listed");
      clickTab(rt, "b.md");
      type(rt, "B edited");
      const root = rt.folderPath;
      assert.equal(typeof rt.win.lightmdGetOpenBuffers, "function");
      assert.deepEqual(rt.win.lightmdGetOpenBuffers(), [
        { root, relative: "a.md", contents: "A", dirty: false },
        { root, relative: "b.md", contents: "B edited", dirty: true },
      ]);
    } finally {
      rt.cleanup();
    }
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { root as repoRoot } from "./helpers/source.mjs";

// Nothing the user typed is lost without being asked: a pending edit is saved
// when its tab loses the editor, and closing tabs, opening another folder,
// starting a new note or closing the window saves what autosave would have
// saved and asks before discarding the rest.

const FOLDER = "/tmp/lightmd-unsaved";
const OTHER = "/tmp/lightmd-unsaved-other";

function boot(options = {}) {
  const rt = bootApp({
    folderPath: FOLDER,
    files: { "a.md": "AAA\n", "b.md": "BBB\n" },
    workspaces: { [OTHER]: { files: { "other.md": "other\n" } } },
    ...options,
  });
  const enabled = rt.autosave.enabled;
  if (options.autosaveOff) rt.autosave.enabled = false;
  const cleanup = rt.cleanup;
  rt.cleanup = () => {
    rt.autosave.enabled = enabled;
    cleanup();
  };
  return rt;
}

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

function tabEl(rt, relative) {
  const el = tabEls(rt).find((t) => (t.dataset.relative || "") === relative);
  assert.ok(el, `no tab for ${JSON.stringify(relative)} in ${JSON.stringify(tabNames(rt))}`);
  return el;
}

function clickTab(rt, relative) {
  return rt.clickAndAwait(tabEl(rt, relative).querySelector(".tab-name"));
}

function closeTab(rt, relative) {
  return rt.clickAndAwait(tabEl(rt, relative).querySelector(".tab-close"));
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function writesOf(rt, relative) {
  return rt.writes.filter((w) => w.relative === relative);
}

async function openAB(rt) {
  await rt.win.lightmdOpenFolder(FOLDER);
  await rt.win.lightmdOpenFile("a.md");
  await rt.win.lightmdOpenFile("b.md");
}

describe("an edit pending autosave is saved when its tab loses the editor", { concurrency: false }, () => {
  test("switching tabs within the autosave delay saves the outgoing tab", async () => {
    const rt = boot({ realAutosave: true });
    try {
      await openAB(rt);
      await clickTab(rt, "a.md");
      type(rt, "AAA edited\n");
      await clickTab(rt, "b.md");
      await settle();
      assert.equal(rt.files.get("a.md"), "AAA edited\n", "the pending edit must be saved, not cancelled");
      assert.equal(rt.el("editor-buffer").value, "BBB\n");
      assert.equal(tabEl(rt, "a.md").dataset.dirty, undefined, "a.md is clean once saved");
    } finally {
      rt.cleanup();
    }
  });

  test("opening another file within the autosave delay saves the outgoing tab", async () => {
    const rt = boot({ realAutosave: true });
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      type(rt, "AAA edited\n");
      await rt.win.lightmdOpenFile("b.md");
      await settle();
      assert.equal(rt.files.get("a.md"), "AAA edited\n");
    } finally {
      rt.cleanup();
    }
  });

  test("with autosave off, a switched-away tab keeps its edit and stays dirty", async () => {
    const rt = boot({ autosaveOff: true });
    try {
      await openAB(rt);
      await clickTab(rt, "a.md");
      type(rt, "AAA edited\n");
      await clickTab(rt, "b.md");
      await settle();
      assert.deepEqual(rt.writes, [], "autosave off writes nothing");
      assert.equal(tabEl(rt, "a.md").dataset.dirty, "true");
      await clickTab(rt, "a.md");
      assert.equal(rt.el("editor-buffer").value, "AAA edited\n");
      assert.equal(rt.el("dirty").hidden, false);
    } finally {
      rt.cleanup();
    }
  });
});

describe("tabs show which files have unsaved changes", { concurrency: false }, () => {
  test("an edit marks its tab dirty and a save clears the mark", async () => {
    const rt = boot({ autosaveOff: true });
    try {
      await openAB(rt);
      assert.equal(tabEl(rt, "b.md").dataset.dirty, undefined);
      assert.equal(tabEl(rt, "b.md").querySelector(".tab-dirty"), null);
      type(rt, "BBB edited\n");
      const tab = tabEl(rt, "b.md");
      assert.equal(tab.dataset.dirty, "true");
      const mark = tab.querySelector(".tab-dirty");
      assert.ok(mark, "a dirty tab shows a marker");
      assert.match(mark.getAttribute("aria-label") || mark.title, /unsaved/i);
      assert.equal(tabEl(rt, "a.md").dataset.dirty, undefined, "only the edited tab is marked");
      await rt.win.lightmdSave();
      assert.equal(tabEl(rt, "b.md").dataset.dirty, undefined);
      assert.equal(tabEl(rt, "b.md").querySelector(".tab-dirty"), null);
    } finally {
      rt.cleanup();
    }
  });
});

describe("closing a dirty tab saves it or asks first", { concurrency: false }, () => {
  test("with autosave on, closing saves the file without asking", async () => {
    const rt = boot();
    try {
      await openAB(rt);
      type(rt, "BBB edited\n");
      await closeTab(rt, "b.md");
      assert.equal(rt.files.get("b.md"), "BBB edited\n");
      assert.deepEqual(rt.confirms, []);
      assert.deepEqual(tabNames(rt), ["a.md"]);
    } finally {
      rt.cleanup();
    }
  });

  test("closing an inactive dirty tab asks about its stashed edit", async () => {
    const rt = boot({ autosaveOff: true });
    try {
      await openAB(rt);
      await clickTab(rt, "a.md");
      type(rt, "AAA edited\n");
      await clickTab(rt, "b.md");
      rt.state.confirmResult = false;
      await closeTab(rt, "a.md");
      assert.equal(rt.confirms.length, 1, "autosave off: closing a dirty tab asks");
      assert.match(rt.confirms[0], /a\.md/);
      assert.deepEqual(tabNames(rt), ["a.md", "b.md"], "Cancel keeps the tab");
      assert.equal(rt.el("editor-buffer").value, "BBB\n", "the active tab is untouched");
    } finally {
      rt.cleanup();
    }
  });

  test("with autosave off, Cancel keeps the tab and its text; OK discards", async () => {
    const rt = boot({ autosaveOff: true });
    try {
      await openAB(rt);
      type(rt, "BBB edited\n");
      rt.state.confirmResult = false;
      await closeTab(rt, "b.md");
      assert.equal(rt.confirms.length, 1);
      assert.match(rt.confirms[0], /unsaved/i);
      assert.match(rt.confirms[0], /b\.md/);
      assert.deepEqual(tabNames(rt), ["a.md", "b.md"]);
      assert.equal(rt.el("editor-buffer").value, "BBB edited\n");
      assert.equal(rt.el("dirty").hidden, false);
      rt.state.confirmResult = true;
      await closeTab(rt, "b.md");
      assert.deepEqual(tabNames(rt), ["a.md"]);
      assert.equal(rt.files.get("b.md"), "BBB\n", "a discarded edit is not written");
      assert.deepEqual(rt.writes, []);
    } finally {
      rt.cleanup();
    }
  });

  test("closing the dirty untitled draft asks first", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "my draft");
      rt.state.confirmResult = false;
      await closeTab(rt, "");
      assert.equal(rt.confirms.length, 1);
      assert.match(rt.confirms[0], /untitled/);
      assert.deepEqual(tabNames(rt), ["(untitled)"]);
      assert.equal(rt.el("editor-buffer").value, "my draft");
    } finally {
      rt.cleanup();
    }
  });

  test("when saving on close fails, it asks before discarding", async () => {
    const rt = boot({
      onInvoke(cmd) {
        if (cmd === "write_workspace_file") throw "No space left on device (os error 28)";
      },
    });
    try {
      await openAB(rt);
      type(rt, "BBB edited\n");
      rt.state.confirmResult = false;
      await closeTab(rt, "b.md");
      assert.equal(rt.confirms.length, 1);
      assert.deepEqual(tabNames(rt), ["a.md", "b.md"]);
      assert.equal(rt.el("editor-buffer").value, "BBB edited\n");
    } finally {
      rt.cleanup();
    }
  });
});

describe("Open Folder and New Note don't drop unsaved work", { concurrency: false }, () => {
  test("Open Folder saves dirty files, asks about the draft, and Cancel keeps everything", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "untitled draft");
      await rt.win.lightmdOpenFile("a.md");
      type(rt, "AAA edited\n");
      const roots = [];
      rt.win.addEventListener("lightmd:workspace-changed", (e) => roots.push(e.detail.root));
      rt.state.confirmResult = false;
      rt.backend.dialog.open = OTHER;
      await rt.clickAndAwait(rt.el("open-folder"));
      assert.equal(rt.files.get("a.md"), "AAA edited\n", "the dirty file is saved");
      assert.equal(rt.confirms.length, 1, "the draft can't be saved, so it asks");
      assert.match(rt.confirms[0], /untitled/);
      assert.deepEqual(tabNames(rt), ["(untitled)", "a.md"], "Cancel keeps the tabs");
      assert.equal(rt.win.lightmdWorkspace.path, FOLDER, "Cancel keeps the folder");
      assert.deepEqual(roots, []);
      rt.state.confirmResult = true;
      await rt.clickAndAwait(rt.el("open-folder"));
      assert.equal(rt.win.lightmdWorkspace.path, OTHER);
      assert.deepEqual(tabNames(rt), []);
    } finally {
      rt.cleanup();
    }
  });

  test("New Note asks before blanking a dirty draft in the background", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "background draft");
      await rt.win.lightmdOpenFile("a.md");
      rt.state.confirmResult = false;
      await rt.win.lightmdNewNote();
      assert.equal(rt.confirms.length, 1);
      assert.match(rt.confirms[0], /untitled/);
      assert.equal(rt.win.lightmdWorkspace.relative, "a.md", "Cancel stays on a.md");
      await clickTab(rt, "");
      assert.equal(rt.el("editor-buffer").value, "background draft");
    } finally {
      rt.cleanup();
    }
  });
});

describe("closing the window doesn't drop unsaved work", { concurrency: false }, () => {
  test("the app may destroy its window when a close is confirmed", () => {
    const cap = JSON.parse(
      readFileSync(join(repoRoot, "src-tauri", "capabilities", "default.json"), "utf8"),
    );
    assert.ok(cap.permissions.includes("core:window:allow-destroy"));
  });

  test("with nothing unsaved, the window closes without asking", async () => {
    const rt = boot();
    try {
      await openAB(rt);
      assert.equal(await rt.requestClose(), true);
      assert.deepEqual(rt.confirms, []);
    } finally {
      rt.cleanup();
    }
  });

  test("dirty file tabs are saved and the window closes", async () => {
    const rt = boot();
    try {
      await openAB(rt);
      await clickTab(rt, "a.md");
      rt.autosave.enabled = false;
      type(rt, "AAA edited\n");
      await clickTab(rt, "b.md");
      type(rt, "BBB edited\n");
      rt.autosave.enabled = true;
      assert.equal(await rt.requestClose(), true);
      assert.equal(rt.files.get("a.md"), "AAA edited\n");
      assert.equal(rt.files.get("b.md"), "BBB edited\n");
      assert.deepEqual(rt.confirms, []);
    } finally {
      rt.cleanup();
    }
  });

  test("an unsaved draft asks, and Cancel keeps the window open", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "draft");
      rt.state.confirmResult = false;
      assert.equal(await rt.requestClose(), false, "Cancel keeps the window");
      assert.equal(rt.confirms.length, 1);
      assert.match(rt.confirms[0], /untitled/);
      rt.state.confirmResult = true;
      assert.equal(await rt.requestClose(), true, "OK closes it");
    } finally {
      rt.cleanup();
    }
  });

  test("with autosave off, dirty files ask before the window closes", async () => {
    const rt = boot({ autosaveOff: true });
    try {
      await openAB(rt);
      type(rt, "BBB edited\n");
      rt.state.confirmResult = false;
      assert.equal(await rt.requestClose(), false);
      assert.match(rt.confirms[0], /b\.md/);
      assert.deepEqual(rt.writes, []);
    } finally {
      rt.cleanup();
    }
  });
});

describe("askConfirm", { concurrency: false }, () => {
  test("awaits an async window.confirm instead of treating its promise as yes", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "draft");
      delete rt.win.__TAURI__.dialog;
      const asked = [];
      rt.win.confirm = async (message) => {
        asked.push(message);
        return false;
      };
      await closeTab(rt, "");
      assert.equal(asked.length, 1);
      assert.deepEqual(tabNames(rt), ["(untitled)"], "an async 'no' keeps the draft");
    } finally {
      rt.cleanup();
    }
  });
});

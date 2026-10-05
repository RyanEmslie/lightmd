import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { createDocument } from "./helpers/dom.mjs";
import { buildTauriGlobals, createInvoke } from "./helpers/tauri.mjs";

// Saving reports what really happened: an edit typed during a write stays
// unsaved, failures show "save failed" instead of vanishing, Save on a new
// note asks where to save it, and Save As never overwrites without asking.

const FOLDER = "/tmp/lightmd-save";
const DISK_FULL = "No space left on device (os error 28)";

function boot(options = {}) {
  const rt = bootApp({
    folderPath: FOLDER,
    files: { "a.md": "AAA\n", "b.md": "BBB\n", "bin.md": { bytes: [0xff, 0xfe, 0x00] } },
    ...options,
  });
  const saved = { enabled: rt.autosave.enabled, delay: rt.autosave.delay };
  const cleanup = rt.cleanup;
  rt.cleanup = () => {
    Object.assign(rt.autosave, saved);
    cleanup();
  };
  return rt;
}

function type(rt, text) {
  const buffer = rt.el("editor-buffer");
  buffer.value = text;
  buffer.dispatchEvent({ type: "input", bubbles: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tabEl(rt, relative) {
  return rt.el("editor-tabs")
    .querySelectorAll('[role="tab"]')
    .find((t) => (t.dataset.relative || "") === relative);
}

function saveFailedShown(rt) {
  return rt.el("status-strip").dataset.error === "save-failed";
}

// Types `text` the moment the next write starts, i.e. while it is in flight.
function typeDuringNextWrite(rt, text) {
  let armed = true;
  return async (cmd) => {
    if (cmd !== "write_workspace_file" || !armed) return undefined;
    armed = false;
    type(rt, text);
    await delay(1);
    return undefined;
  };
}

describe("an edit typed while a save is writing stays unsaved", { concurrency: false }, () => {
  test("Save: the later edit keeps the file dirty", async () => {
    let during = null;
    const rt = boot({ onInvoke: (...args) => during?.(...args) });
    try {
      rt.autosave.enabled = false;
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      type(rt, "v1");
      during = typeDuringNextWrite(rt, "v1 and more");
      await rt.win.lightmdSave();
      assert.equal(rt.files.get("a.md"), "v1");
      assert.equal(rt.el("dirty").hidden, false, "'and more' was never saved");
      assert.equal(tabEl(rt, "a.md").dataset.dirty, "true");
    } finally {
      rt.cleanup();
    }
  });

  test("Save: the later edit's autosave is not cancelled", async () => {
    let during = null;
    const rt = boot({ realAutosave: true, onInvoke: (...args) => during?.(...args) });
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      rt.autosave.delay = 10;
      type(rt, "v1");
      during = typeDuringNextWrite(rt, "v1 and more");
      await rt.win.lightmdSave();
      await delay(40);
      assert.equal(rt.files.get("a.md"), "v1 and more", "autosave must still save the later edit");
      assert.equal(rt.el("dirty").hidden, true);
    } finally {
      rt.cleanup();
    }
  });

  test("Save As: the later edit keeps the new file dirty", async () => {
    let during = null;
    const rt = boot({
      dialog: { save: `${FOLDER}/fresh.md` },
      onInvoke: (...args) => during?.(...args),
    });
    try {
      rt.autosave.enabled = false;
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "draft");
      during = typeDuringNextWrite(rt, "draft and more");
      assert.equal(await rt.win.lightmdSaveAs(), true);
      assert.equal(rt.files.get("fresh.md"), "draft");
      assert.equal(rt.win.lightmdWorkspace.relative, "fresh.md");
      assert.equal(rt.el("dirty").hidden, false);
    } finally {
      rt.cleanup();
    }
  });
});

describe("Save on a new note", { concurrency: false }, () => {
  test("opens Save As and binds the note to the chosen file", async () => {
    const rt = boot({ dialog: { save: `${FOLDER}/picked.md` } });
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "brand new");
      await rt.win.lightmdSave();
      assert.ok(rt.dialogs.some((d) => d.kind === "save"), "Save must offer the Save As picker");
      assert.equal(rt.files.get("picked.md"), "brand new");
      assert.equal(rt.win.lightmdWorkspace.relative, "picked.md");
      assert.equal(rt.el("dirty").hidden, true);
    } finally {
      rt.cleanup();
    }
  });
});

describe("save errors are shown, not swallowed", { concurrency: false }, () => {
  test("a failed Save resolves, shows 'save failed' and keeps the edit dirty", async () => {
    let fail = true;
    const rt = boot({
      onInvoke(cmd) {
        if (cmd === "write_workspace_file" && fail) throw DISK_FULL;
      },
    });
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      type(rt, "edit");
      await rt.win.lightmdSave();
      assert.equal(saveFailedShown(rt), true);
      assert.match(rt.el("status-path").textContent, /save failed/i);
      assert.equal(rt.el("dirty").hidden, false);
      fail = false;
      await rt.win.lightmdSave();
      assert.equal(saveFailedShown(rt), false, "a successful Save clears the stale error");
      assert.doesNotMatch(rt.el("status-path").textContent, /save failed/i);
      assert.equal(rt.el("dirty").hidden, true);
    } finally {
      rt.cleanup();
    }
  });

  test("a failed Save As resolves false and shows 'save failed'", async () => {
    const rt = boot({
      dialog: { save: `${FOLDER}/fresh.md` },
      onInvoke(cmd) {
        if (cmd === "write_workspace_file") throw DISK_FULL;
      },
    });
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "draft");
      assert.equal(await rt.win.lightmdSaveAs(), false);
      assert.equal(saveFailedShown(rt), true);
      assert.equal(rt.win.lightmdWorkspace.relative, null, "the note stays unsaved");
      assert.equal(rt.el("dirty").hidden, false);
    } finally {
      rt.cleanup();
    }
  });

  test("a file that can't be opened doesn't cancel the current file's pending autosave", async () => {
    const rt = boot({ realAutosave: true });
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      rt.autosave.delay = 20;
      type(rt, "pending edit");
      await assert.rejects(rt.win.lightmdOpenFile("bin.md"));
      await delay(50);
      assert.equal(rt.files.get("a.md"), "pending edit");
      assert.equal(rt.win.lightmdWorkspace.relative, "a.md");
    } finally {
      rt.cleanup();
    }
  });
});

describe("autosave failures", { concurrency: false }, () => {
  test("an autosave that fails after another was scheduled still shows the error", async () => {
    const { autosave, cancelAutosave, scheduleAutoSave } = await import("../src/autosave.js");
    let release;
    const backend = createInvoke({
      root: FOLDER,
      files: { "a.md": "AAA\n" },
      async onInvoke(cmd) {
        if (cmd !== "write_workspace_file") return undefined;
        await new Promise((resolve) => {
          release = resolve;
        });
        throw DISK_FULL;
      },
    });
    const doc = createDocument();
    const prev = { document: globalThis.document, window: globalThis.window };
    const saved = { enabled: autosave.enabled, delay: autosave.delay };
    const dirtyCalls = [];
    globalThis.document = doc;
    globalThis.window = {
      __TAURI__: buildTauriGlobals(backend.invoke).__TAURI__,
      lightmdWorkspace: { path: FOLDER, relative: "a.md", contents: "edit" },
      lightmdSetDirty: (value) => dirtyCalls.push(value),
    };
    try {
      autosave.enabled = true;
      autosave.delay = 1;
      scheduleAutoSave();
      await delay(10);
      assert.equal(typeof release, "function", "precondition: the write is in flight");
      cancelAutosave(); // the user switched tabs meanwhile
      release();
      await delay(5);
      assert.equal(doc.getElementById("status-strip").dataset.error, "save-failed");
      assert.deepEqual(dirtyCalls, [], "a failed save never marks anything clean");
    } finally {
      cancelAutosave();
      Object.assign(autosave, saved);
      globalThis.document = prev.document;
      globalThis.window = prev.window;
    }
  });

  test("the app's autosave saves the active tab and shows a failure on it", async () => {
    let fail = true;
    const rt = boot({
      realAutosave: true,
      onInvoke(cmd) {
        if (cmd === "write_workspace_file" && fail) throw DISK_FULL;
      },
    });
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      rt.autosave.delay = 1;
      type(rt, "edit");
      await delay(20);
      assert.equal(saveFailedShown(rt), true);
      assert.equal(tabEl(rt, "a.md").dataset.dirty, "true");
      fail = false;
      type(rt, "edit 2");
      await delay(20);
      assert.equal(rt.files.get("a.md"), "edit 2");
      assert.equal(saveFailedShown(rt), false);
      assert.equal(tabEl(rt, "a.md").dataset.dirty, undefined);
    } finally {
      rt.cleanup();
    }
  });
});

describe("Save As overwrite check", { concurrency: false }, () => {
  test("asks before writing when it can't tell whether the file exists", async () => {
    const rt = boot({
      onInvoke(cmd) {
        if (cmd === "workspace_file_exists" || cmd === "read_workspace_file") {
          throw "Permission denied (os error 13)";
        }
      },
    });
    try {
      rt.backend.dialog.open = FOLDER;
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "would clobber a.md");
      rt.state.confirmResult = false;
      assert.equal(await rt.win.lightmdSaveAs({ path: FOLDER, relative: "a.md" }), false);
      assert.equal(rt.confirms.length, 1);
      assert.match(rt.confirms[0], /a\.md/);
      assert.equal(rt.files.get("a.md"), "AAA\n");
    } finally {
      rt.cleanup();
    }
  });
});

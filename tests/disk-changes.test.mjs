import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bootApp } from "./helpers/app.mjs";

// A file changed by another program is never silently overwritten: each tab
// remembers the file's modified time, saves pass it as expectedModifiedMs, and
// a conflict asks whether to overwrite, reload from disk, or keep editing.

const FOLDER = "/tmp/lightmd-disk";

function boot(options = {}) {
  const rt = bootApp({
    folderPath: FOLDER,
    files: { "a.md": "AAA\n", "b.md": "BBB\n" },
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

// The conflict dialog's buttons, as dialog.message() returns them.
function answer(rt, label) {
  rt.backend.dialog.confirm = (message, args) => {
    const buttons = args && args.buttons && args.buttons.YesNoCancelCustom;
    if (!buttons) return false;
    return { overwrite: buttons[0], reload: buttons[1], cancel: buttons[2] }[label];
  };
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

function clickTab(rt, relative) {
  return rt.clickAndAwait(tabEl(rt, relative).querySelector(".tab-name"));
}

function otherProgramWrites(rt, relative, text) {
  rt.backend.write(FOLDER, relative, text);
}

describe("saves carry the modified time the tab last saw", { concurrency: false }, () => {
  test("from the read, then from each write's result", async () => {
    const rt = boot();
    try {
      rt.autosave.enabled = false;
      await rt.win.lightmdOpenFolder(FOLDER);
      const opened = rt.backend.mtime(FOLDER, "a.md");
      await rt.win.lightmdOpenFile("a.md");
      type(rt, "one");
      await rt.win.lightmdSave();
      assert.equal(rt.writes.at(-1).expectedModifiedMs, opened);
      const afterFirst = rt.backend.mtime(FOLDER, "a.md");
      type(rt, "two");
      await rt.win.lightmdSave();
      assert.equal(rt.writes.at(-1).expectedModifiedMs, afterFirst);
      assert.equal(rt.files.get("a.md"), "two");
    } finally {
      rt.cleanup();
    }
  });

  test("a file bound by Save As saves with the time Save As wrote", async () => {
    const rt = boot({ dialog: { save: `${FOLDER}/fresh.md` } });
    try {
      rt.autosave.enabled = false;
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdNewNote();
      type(rt, "draft");
      await rt.win.lightmdSaveAs();
      const bound = rt.backend.mtime(FOLDER, "fresh.md");
      type(rt, "draft 2");
      await rt.win.lightmdSave();
      assert.equal(rt.writes.at(-1).expectedModifiedMs, bound);
      assert.deepEqual(rt.confirms, []);
    } finally {
      rt.cleanup();
    }
  });
});

describe("our own saves never look like someone else's change", { concurrency: false }, () => {
  test("a Save while another save of the file is writing waits for it instead of conflicting", async () => {
    const rt = boot({
      onInvoke: async (cmd) => {
        if (cmd === "write_workspace_file") await delay(10);
      },
    });
    try {
      rt.autosave.enabled = false;
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      type(rt, "first");
      const first = rt.win.lightmdSave();
      type(rt, "first and second");
      const second = rt.win.lightmdSave();
      await Promise.all([first, second]);
      assert.deepEqual(rt.confirms, [], "no conflict between our own two writes");
      assert.equal(rt.files.get("a.md"), "first and second");
      assert.equal(rt.el("dirty").hidden, true);
    } finally {
      rt.cleanup();
    }
  });
});

describe("saving over a file another program changed asks first", { concurrency: false }, () => {
  async function conflicted(rt) {
    rt.autosave.enabled = false;
    await rt.win.lightmdOpenFolder(FOLDER);
    await rt.win.lightmdOpenFile("a.md");
    otherProgramWrites(rt, "a.md", "theirs\n");
    type(rt, "mine\n");
  }

  test("Overwrite writes my version", async () => {
    const rt = boot();
    try {
      await conflicted(rt);
      answer(rt, "overwrite");
      await rt.win.lightmdSave();
      assert.equal(rt.confirms.length, 1);
      assert.match(rt.confirms[0], /a\.md/);
      assert.match(rt.confirms[0], /changed on disk/i);
      assert.equal(rt.files.get("a.md"), "mine\n");
      assert.equal(rt.el("dirty").hidden, true);
      type(rt, "mine again\n");
      await rt.win.lightmdSave();
      assert.equal(rt.confirms.length, 1, "after overwriting, the next save has the new time");
      assert.equal(rt.files.get("a.md"), "mine again\n");
    } finally {
      rt.cleanup();
    }
  });

  test("Reload replaces my edit with the version on disk", async () => {
    const rt = boot();
    try {
      await conflicted(rt);
      answer(rt, "reload");
      await rt.win.lightmdSave();
      assert.equal(rt.files.get("a.md"), "theirs\n");
      assert.equal(rt.el("editor-buffer").value, "theirs\n");
      assert.equal(rt.el("dirty").hidden, true);
      type(rt, "theirs\nplus mine\n");
      await rt.win.lightmdSave();
      assert.equal(rt.confirms.length, 1, "after reloading, the next save has the new time");
      assert.equal(rt.files.get("a.md"), "theirs\nplus mine\n");
    } finally {
      rt.cleanup();
    }
  });

  test("Cancel keeps my edit unsaved; autosave doesn't ask again, Save does", async () => {
    const rt = boot({ realAutosave: true });
    try {
      await conflicted(rt);
      answer(rt, "cancel");
      await rt.win.lightmdSave();
      assert.equal(rt.files.get("a.md"), "theirs\n");
      assert.equal(rt.el("editor-buffer").value, "mine\n");
      assert.equal(rt.el("dirty").hidden, false);
      rt.autosave.enabled = true;
      rt.autosave.delay = 1;
      type(rt, "mine, still typing\n");
      await delay(20);
      assert.equal(rt.confirms.length, 1, "autosave must not nag about a conflict the user put off");
      assert.equal(rt.files.get("a.md"), "theirs\n");
      answer(rt, "overwrite");
      await rt.win.lightmdSave();
      assert.equal(rt.confirms.length, 2);
      assert.equal(rt.files.get("a.md"), "mine, still typing\n");
    } finally {
      rt.cleanup();
    }
  });

  test("autosave over a changed file asks too", async () => {
    const rt = boot({ realAutosave: true });
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      otherProgramWrites(rt, "a.md", "theirs\n");
      answer(rt, "overwrite");
      rt.autosave.delay = 1;
      type(rt, "mine\n");
      await delay(20);
      assert.equal(rt.confirms.length, 1);
      assert.equal(rt.files.get("a.md"), "mine\n");
    } finally {
      rt.cleanup();
    }
  });
});

describe("a clean tab follows its file when it comes back", { concurrency: false }, () => {
  test("switching back to a clean tab reloads a file changed on disk", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      await rt.win.lightmdOpenFile("b.md");
      otherProgramWrites(rt, "a.md", "a from git pull\n");
      await clickTab(rt, "a.md");
      assert.equal(rt.el("editor-buffer").value, "a from git pull\n");
      type(rt, "a from git pull\nedit\n");
      await rt.win.lightmdSave();
      assert.equal(rt.files.get("a.md"), "a from git pull\nedit\n");
      assert.deepEqual(rt.confirms, []);
    } finally {
      rt.cleanup();
    }
  });

  test("reopening it from the explorer reloads it too", async () => {
    const rt = boot();
    try {
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      await rt.win.lightmdOpenFile("b.md");
      otherProgramWrites(rt, "a.md", "v2\n");
      await rt.win.lightmdOpenFile("a.md");
      assert.equal(rt.el("editor-buffer").value, "v2\n");
    } finally {
      rt.cleanup();
    }
  });

  test("a dirty tab keeps its edit when it comes back", async () => {
    const rt = boot();
    try {
      rt.autosave.enabled = false;
      await rt.win.lightmdOpenFolder(FOLDER);
      await rt.win.lightmdOpenFile("a.md");
      type(rt, "mine\n");
      await rt.win.lightmdOpenFile("b.md");
      otherProgramWrites(rt, "a.md", "theirs\n");
      await clickTab(rt, "a.md");
      assert.equal(rt.el("editor-buffer").value, "mine\n");
      assert.equal(rt.el("dirty").hidden, false);
    } finally {
      rt.cleanup();
    }
  });
});

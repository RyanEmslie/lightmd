import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeTimers, mockEl } from "./helpers/dom.mjs";
import { buildTauriGlobals, createInvoke } from "./helpers/tauri.mjs";

const SHORT_DELAY_MS = 10_000;

installDocument();

const { autosave, cancelAutosave, scheduleAutoSave } = await import(
  "../src/autosave.js"
);

function installDocument() {
  const byId = new Map();
  const doc = {
    getElementById(id) {
      if (!byId.has(String(id))) {
        const el = mockEl(id, id === "status-path" ? "span" : "div");
        byId.set(String(id), el);
      }
      return byId.get(String(id));
    },
    createElement(tag) {
      return mockEl("", tag);
    },
  };
  globalThis.document = doc;
  globalThis.window = globalThis;
}

async function runAutosave({ enabled = true, reject = false } = {}) {
  const timers = installFakeTimers();
  const prevEnabled = autosave.enabled;
  const prevDelay = autosave.delay;
  const prevTauri = globalThis.__TAURI__;
  const prevWs = globalThis.lightmdWorkspace;
  const prevSetDirty = globalThis.lightmdSetDirty;
  const dirtyCalls = [];
  let dirty = true;
  const backend = createInvoke({
    root: "/tmp/lightmd-workspace",
    files: { "note.md": "# saved\n" },
    onInvoke(cmd) {
      if (cmd === "write_workspace_file" && reject) throw "disk full";
    },
  });
  const invokes = backend.invokes;

  globalThis.__TAURI__ = buildTauriGlobals(backend.invoke).__TAURI__;
  globalThis.lightmdWorkspace = {
    path: "/tmp/lightmd-workspace",
    relative: "note.md",
    contents: "# dirty buffer\n",
  };
  globalThis.lightmdSetDirty = (value) => {
    dirtyCalls.push(value);
    dirty = Boolean(value);
  };

  autosave.enabled = enabled;
  autosave.delay = 1;
  cancelAutosave();
  scheduleAutoSave();

  try {
    await timers.flush();
    await Promise.resolve();
    return { dirty, dirtyCalls, invokes, backend };
  } finally {
    timers.restore();
    cancelAutosave();
    autosave.enabled = prevEnabled;
    autosave.delay = prevDelay;
    if (prevTauri === undefined) delete globalThis.__TAURI__;
    else globalThis.__TAURI__ = prevTauri;
    if (prevWs === undefined) delete globalThis.lightmdWorkspace;
    else globalThis.lightmdWorkspace = prevWs;
    if (prevSetDirty === undefined) delete globalThis.lightmdSetDirty;
    else globalThis.lightmdSetDirty = prevSetDirty;
  }
}

test("default autosave is on with a short delay (testable config)", () => {
  assert.equal(autosave.enabled, true, "default autosave must be on");
  assert.ok(
    Number.isFinite(autosave.delay) &&
      autosave.delay > 0 &&
      autosave.delay <= SHORT_DELAY_MS,
    "default autosave delay must be short",
  );
});

test("autosave on: an edit schedules a write of the editor buffer after the delay without clicking Save", async () => {
  const run = await runAutosave({ enabled: true });
  const write = run.invokes.find((c) => c.cmd === "write_workspace_file");
  assert.ok(write, "autosave must invoke write_workspace_file");
  assert.equal(write.args.relative, "note.md");
  assert.equal(write.args.contents, "# dirty buffer\n");
  assert.equal(run.backend.files.get("note.md"), "# dirty buffer\n", "the write must reach the file");
});

test("autosave off leaves dirty (no write while off)", async () => {
  const run = await runAutosave({ enabled: false });
  assert.equal(
    run.invokes.some((c) => c.cmd === "write_workspace_file"),
    false,
    "autosave off must not write",
  );
  assert.equal(run.dirty, true, "dirty stays true while autosave is off");
  assert.equal(run.dirtyCalls.includes(false), false);
});

test("dirty clears after a successful autosave", async () => {
  const run = await runAutosave({ enabled: true });
  assert.equal(run.dirty, false, "successful autosave must clear dirty");
  assert.ok(run.dirtyCalls.includes(false), "setDirty(false) after a successful write");
});

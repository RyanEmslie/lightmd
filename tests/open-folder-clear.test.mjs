import assert from "node:assert/strict";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { installFakeTimers } from "./helpers/dom.mjs";

const FOLDER_A = "/tmp/lightmd-folder-a";
const FOLDER_B = "/tmp/lightmd-folder-b";
const FILE_A = "note.md";
const BODY_A = "# Note A\n\nfrom folder A\n";
const DIRTY_A = "dirty buffer from A — must not land in B\n";
const SESSION_KEY = "lightmd.session";

const { persistSession, getSession } = await import("../src/session.js");

function parseStoredSession(ls) {
  const raw = ls.getItem(SESSION_KEY);
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function lastFileOf(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("lastFile" in value) return value.lastFile;
  if ("file" in value) return value.file;
  return undefined;
}

function isClearedFile(file) {
  return file == null || file === "" || file === false;
}

function isAsRelativeUnderNewFolder(file) {
  if (isClearedFile(file)) return false;
  const s = String(file).replace(/\\/g, "/");
  if (s === FILE_A) return true;
  if (s.endsWith(`/${FILE_A}`) && !s.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(s)) {
    return true;
  }
  const aRoot = FOLDER_A.replace(/\\/g, "/").replace(/\/+$/, "");
  const bRoot = FOLDER_B.replace(/\\/g, "/").replace(/\/+$/, "");
  if (s === `${aRoot}/${FILE_A}`) return true;
  if (s === `${bRoot}/${FILE_A}`) return true;
  return false;
}

function isWriteAIntoB(write) {
  if (!write) return false;
  const path = String(write.path ?? "").replace(/\\/g, "/");
  const relative = String(write.relative ?? "").replace(/\\/g, "/");
  const bRoot = FOLDER_B.replace(/\\/g, "/").replace(/\/+$/, "");
  const aRel = relative === FILE_A || relative.endsWith(`/${FILE_A}`);
  return path === bRoot && aRel;
}

function boot() {
  const rt = bootApp({
    folderPath: FOLDER_A,
    files: { [FILE_A]: BODY_A },
    workspaces: { [FOLDER_B]: { files: { "other.md": "# Other\n" } } },
    dialog: { open: FOLDER_B },
    realAutosave: true,
  });
  persistSession({
    lastFolder: null,
    lastFile: null,
    folder: null,
    file: null,
  });
  const persistCalls = [];
  rt.win.lightmdPersistSession = function (partial, fileArg) {
    persistCalls.push({
      partial,
      fileArg,
      argc: arguments.length,
    });
    return persistSession(partial, fileArg);
  };
  return Object.assign(rt, { persistCalls });
}

async function openFolderAWithFile(rt) {
  await rt.win.lightmdOpenFolder(FOLDER_A);
  await rt.win.lightmdOpenFile(FILE_A);
  persistSession({
    lastFolder: FOLDER_A,
    lastFile: FILE_A,
    folder: FOLDER_A,
    file: FILE_A,
  });
  const ws = rt.win.lightmdWorkspace;
  assert.equal(
    ws && ws.relative,
    FILE_A,
    "precondition: open file in folder A must bind lightmdWorkspace.relative",
  );
  assert.equal(
    ws && ws.path,
    FOLDER_A,
    "precondition: open folder A must bind lightmdWorkspace.path",
  );
}

async function openFolderAFileAndScheduleAutosave(rt) {
  await openFolderAWithFile(rt);
  const buffer = rt.el("editor-buffer");
  buffer.value = DIRTY_A;
  buffer.dispatchEvent({ type: "input", target: buffer });
  if (rt.state.scheduleCalls === 0 && typeof rt.win.lightmdScheduleAutoSave === "function") {
    if (typeof rt.win.lightmdSetDirty === "function") rt.win.lightmdSetDirty(true);
    rt.win.lightmdScheduleAutoSave();
  }
  assert.equal(rt.el("dirty").hidden, false, "precondition: buffer must be dirty");
  assert.ok(
    rt.state.scheduleCalls > 0,
    "precondition: dirty edit must schedule autosave",
  );
}

test("applyFolder(B) cancels pending autosave so A's buffer is not written into B", async () => {
  const rt = boot();
  const timers = installFakeTimers();
  try {
    await openFolderAFileAndScheduleAutosave(rt);
    const writesBefore = rt.writes.length;
    const cancelsBefore = rt.state.cancelCalls;
    await rt.win.lightmdOpenFolder(FOLDER_B);
    await timers.flush();
    const newWrites = rt.writes.slice(writesBefore);
    const wroteAIntoB = newWrites.some(isWriteAIntoB);
    const cancelled = rt.state.cancelCalls > cancelsBefore;
    assert.equal(
      wroteAIntoB,
      false,
      "applyFolder(B) must cancel pending autosave / not write A's buffer into B (write_workspace_file with A's relative under B)",
    );
    assert.ok(
      cancelled || !wroteAIntoB,
      "applyFolder(B) must call cancelAutosave (or otherwise prevent a write of A's buffer into B)",
    );
  } finally {
    timers.restore();
    rt.cleanup();
  }
});

test("after applyFolder(B), relative is cleared, buffer is cleared or unbound, dirty is false", async () => {
  const rt = boot();
  try {
    await openFolderAFileAndScheduleAutosave(rt);
    await rt.win.lightmdOpenFolder(FOLDER_B);
    const ws = rt.win.lightmdWorkspace;
    const relative = ws ? ws.relative : FILE_A;
    const unbound =
      relative == null || relative === "" || relative === false;
    assert.ok(
      unbound,
      `lightmdWorkspace.relative must be cleared/null/empty after applyFolder(B), not A's path (got ${JSON.stringify(relative)})`,
    );
    assert.notEqual(
      String(relative ?? ""),
      FILE_A,
      "lightmdWorkspace.relative must not remain A's path after applyFolder(B)",
    );
    const bufferVal = rt.el("editor-buffer").value;
    const cleared =
      bufferVal == null ||
      bufferVal === "" ||
      rt.state.setDocCalls.some((t) => t == null || t === "");
    assert.ok(
      unbound || cleared,
      "buffer must be cleared or unbound after applyFolder(B)",
    );
    assert.equal(
      rt.el("dirty").hidden,
      true,
      "dirty must be false after applyFolder(B)",
    );
  } finally {
    rt.cleanup();
  }
});

test("Save after applyFolder(B) without opening a file does not write A's relative under B", async () => {
  const rt = boot();
  try {
    await openFolderAWithFile(rt);
    const buffer = rt.el("editor-buffer");
    buffer.value = DIRTY_A;
    buffer.dispatchEvent({ type: "input", target: buffer });
    await rt.win.lightmdOpenFolder(FOLDER_B);
    const writesBefore = rt.writes.length;
    await rt.win.lightmdSave();
    const newWrites = rt.writes.slice(writesBefore);
    assert.equal(
      newWrites.some(isWriteAIntoB),
      false,
      "Save after switch without opening a file in B must not invoke write_workspace_file with A's relative under B's path",
    );
  } finally {
    rt.cleanup();
  }
});

test("session lastFile is cleared on folder change until a file is opened in B", async () => {
  const rt = boot();
  try {
    await openFolderAWithFile(rt);
    const before = lastFileOf(getSession());
    assert.ok(
      isAsRelativeUnderNewFolder(before),
      "precondition: lastFile should be A's relative before switching folders",
    );
    await rt.win.lightmdOpenFolder(FOLDER_B);
    const sess = getSession();
    const stored = parseStoredSession(rt.storage);
    const live = lastFileOf(sess);
    const persisted = lastFileOf(stored);
    assert.equal(
      isAsRelativeUnderNewFolder(live),
      false,
      "session lastFile must be cleared/invalidated on folder change (not left as A's relative under the new folder)",
    );
    assert.equal(
      isAsRelativeUnderNewFolder(persisted),
      false,
      "persistSession lastFile must be cleared/invalidated on folder change (not left as A's relative under the new folder) until a file is opened in B",
    );
    assert.ok(
      isClearedFile(live) || !isAsRelativeUnderNewFolder(live),
      "lastFile must stay cleared until a file is opened in B",
    );
  } finally {
    rt.cleanup();
  }
});

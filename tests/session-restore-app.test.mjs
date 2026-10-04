import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { srcDir } from "./helpers/source.mjs";

// src/session.js restoring into the real app glue (src/index.html's inline
// script) against the fake backend. In the webview window === globalThis; in
// Node the glue's hooks live on rt.win, so link() shares them.

const SESSION_KEY = "lightmd.session";
let fresh = 0;

async function boot(options, stored) {
  const rt = bootApp(options);
  if (stored) rt.storage.setItem(SESSION_KEY, JSON.stringify(stored));
  const href = pathToFileURL(join(srcDir, "session.js")).href;
  const session = await import(`${href}?app=${++fresh}`);
  const linked = ["lightmdOpenFolder", "lightmdOpenFile", "lightmdEditor"];
  for (const key of linked) globalThis[key] = rt.win[key];
  rt.win.lightmdPersistSession = session.persistSession;
  const cleanup = rt.cleanup;
  rt.cleanup = () => {
    for (const key of linked) delete globalThis[key];
    cleanup();
  };
  return { rt, session };
}

const reads = (rt) => rt.invokes.filter((call) => call.cmd === "read_workspace_file");

test("session restore reads the last file once and renders it once", async () => {
  const body = "# Note\n\nrestored\n";
  const { rt, session } = await boot(
    { files: { "note.md": body } },
    { lastFolder: "/tmp/lightmd-ws", lastFile: "note.md" },
  );
  try {
    await session.restoreSession();
    assert.equal(reads(rt).length, 1, "the file is read once");
    assert.equal(rt.el("editor-buffer").value, body);
    assert.deepEqual(
      rt.state.setDocCalls.filter((text) => text === body),
      [body],
      "the restored text reaches the editor once",
    );
    const tabs = rt.el("editor-tabs").querySelectorAll('[role="tab"]');
    assert.deepEqual(
      [...tabs].map((tab) => tab.dataset.relative),
      ["note.md"],
      "the restored file opens as a tab",
    );
    assert.equal(rt.el("status-path").textContent, "note.md");
  } finally {
    rt.cleanup();
  }
});

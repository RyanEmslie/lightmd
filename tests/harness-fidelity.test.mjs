import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bootApp } from "./helpers/app.mjs";
import { createDocument, mockEl } from "./helpers/dom.mjs";
import { KNOWN_COMMANDS, createInvoke } from "./helpers/tauri.mjs";

// The fakes in tests/helpers must behave like the real Tauri backend and the
// real DOM, or app bugs hide behind them. These tests pin that fidelity.

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected the promise to reject");
}

describe("fake Tauri backend mirrors the real one", () => {
  test("unknown commands reject like real Tauri", async () => {
    const { invoke } = createInvoke();
    assert.equal(await rejection(invoke("write_file", {})), "Command write_file not found");
    assert.equal(await rejection(invoke("exists", {})), "Command exists not found");
  });

  test("exports one known-command list with the Rust and plugin commands", () => {
    assert.ok(Array.isArray(KNOWN_COMMANDS));
    for (const cmd of [
      "list_workspace",
      "read_workspace_file",
      "write_workspace_file",
      "read_workspace_image",
      "create_workspace_folder",
      "workspace_file_exists",
      "plugin:dialog|open",
      "plugin:dialog|save",
      "plugin:dialog|message",
      "plugin:opener|open_url",
    ]) {
      assert.ok(KNOWN_COMMANDS.includes(cmd), `KNOWN_COMMANDS must include ${cmd}`);
    }
  });

  test("reads honour args.path: the same relative under two roots is two files", async () => {
    const { invoke } = createInvoke({
      root: "/ws/a",
      files: { "note.md": "A" },
      workspaces: { "/ws/b": { files: { "note.md": "B" } } },
    });
    assert.equal(await invoke("read_workspace_file", { path: "/ws/a", relative: "note.md" }), "A");
    assert.equal(await invoke("read_workspace_file", { path: "/ws/b", relative: "note.md" }), "B");
  });

  test("a write under a different root lands under that root, not the workspace", async () => {
    const backend = createInvoke({
      root: "/ws/a",
      files: { "note.md": "A" },
      workspaces: { "/elsewhere": {} },
    });
    await backend.invoke("write_workspace_file", {
      path: "/elsewhere",
      relative: "note.md",
      contents: "moved",
    });
    assert.equal(backend.files.get("note.md"), "A", "the workspace copy must be untouched");
    assert.equal(backend.read("/elsewhere", "note.md"), "moved");
  });

  test("listings honour args.path and list folders and md/html files like Rust", async () => {
    const { invoke } = createInvoke({
      root: "/ws/a",
      files: { "b.md": "", "notes/nested.md": "", "img.png": { bytes: [1] }, "Page.HTML": "" },
      workspaces: { "/ws/b": { files: { "other.md": "" } } },
    });
    assert.deepEqual(await invoke("list_workspace", { path: "/ws/a" }), [
      { relative_path: "b.md", is_dir: false },
      { relative_path: "notes", is_dir: true },
      { relative_path: "notes/nested.md", is_dir: false },
      { relative_path: "Page.HTML", is_dir: false },
    ]);
    assert.deepEqual(await invoke("list_workspace", { path: "/ws/b" }), [
      { relative_path: "other.md", is_dir: false },
    ]);
  });

  test("errors are plain strings, like Rust's String errors", async () => {
    const { invoke } = createInvoke({ root: "/ws", files: { "a.md": "A" } });
    const missing = await rejection(invoke("read_workspace_file", { path: "/ws", relative: "nope.md" }));
    assert.equal(missing, "No such file or directory (os error 2)");
    const outside = await rejection(
      invoke("write_workspace_file", { path: "/ws", relative: "../x.md", contents: "" }),
    );
    assert.equal(outside, "path is outside workspace root");
    const noRoot = await rejection(invoke("list_workspace", { path: "/not/there" }));
    assert.equal(typeof noRoot, "string");
  });

  test("missing or mistyped args reject like Tauri's argument check", async () => {
    const { invoke } = createInvoke({ root: "/ws", files: { "a.md": "A" } });
    const err = await rejection(invoke("read_workspace_file", { root: "/ws", relative: "a.md" }));
    assert.match(String(err), /missing required key path/);
    const typed = await rejection(invoke("read_workspace_file", { path: null, relative: "a.md" }));
    assert.match(String(typed), /invalid type: null, expected a string/);
  });

  test("dialog plugin commands answer from the configured dialog state", async () => {
    const backend = createInvoke({ root: "/ws", dialog: { open: "/ws", confirm: true } });
    assert.equal(
      await backend.invoke("plugin:dialog|open", { options: { directory: true } }),
      "/ws",
    );
    assert.equal(
      await backend.invoke("plugin:dialog|message", { message: "Overwrite?", buttons: "OkCancel" }),
      "Ok",
    );
    backend.dialog.confirm = false;
    assert.equal(
      await backend.invoke("plugin:dialog|message", { message: "Again?", buttons: "OkCancel" }),
      "Cancel",
    );
    assert.deepEqual(backend.confirms, ["Overwrite?", "Again?"]);
  });
});

describe("fake DOM mirrors src/index.html and the real DOM", () => {
  test("getElementById returns null for ids that are not in the markup", () => {
    const doc = createDocument();
    for (const id of ["save", "save-as", "explorer-sort", "theme", "made-up"]) {
      assert.equal(doc.getElementById(id), null, `#${id} is not in src/index.html`);
    }
  });

  test("getElementById returns the parsed markup element with its attributes", () => {
    const doc = createDocument();
    const toggle = doc.getElementById("show-extensions");
    assert.equal(toggle.tagName, "INPUT");
    assert.equal(toggle.type, "checkbox");
    assert.equal(toggle.checked, true);
    assert.equal(doc.getElementById("open-folder").tagName, "BUTTON");
    assert.equal(doc.getElementById("dirty").hidden, true);
    assert.ok(doc.getElementById("explorer").contains(doc.getElementById("file-list")));
  });

  test("runtime-created ids are found once attached, and not while detached", () => {
    const doc = createDocument();
    const made = doc.createElement("div");
    made.id = "runtime-made";
    assert.equal(doc.getElementById("runtime-made"), null);
    doc.body.appendChild(made);
    assert.equal(doc.getElementById("runtime-made"), made);
  });

  test("closest() supports attribute selectors", () => {
    const tab = mockEl("", "button");
    tab.setAttribute("role", "tab");
    tab.dataset.x = "1";
    const label = mockEl("", "span");
    tab.appendChild(label);
    assert.equal(label.closest('[role="tab"]'), tab);
    assert.equal(label.closest("button[data-x]"), tab);
    assert.equal(label.closest('[role="tablist"]'), null);
  });

  test("insertAdjacentHTML creates real child elements", () => {
    const host = mockEl("", "div");
    host.insertAdjacentHTML(
      "afterbegin",
      '<h1 id="t">Title</h1><p><img src="a.png" alt="A"><a href="https://x.test">x</a></p>',
    );
    assert.equal(host.querySelector("h1").textContent, "Title");
    assert.equal(host.querySelector("img").getAttribute("src"), "a.png");
    assert.equal(host.querySelector("a").getAttribute("href"), "https://x.test");
  });

  test("click events bubble to ancestor listeners", () => {
    const parent = mockEl("", "ul");
    const child = mockEl("", "li");
    parent.appendChild(child);
    let seen = null;
    parent.addEventListener("click", (event) => {
      seen = event.target;
    });
    child.click();
    assert.equal(seen, child);
  });
});

describe("bootApp runs the inline app glue against the real markup", () => {
  test("rt.el() only finds real ids", () => {
    const rt = bootApp();
    try {
      assert.equal(rt.el("save"), null);
      assert.equal(rt.el("open-folder").tagName, "BUTTON");
    } finally {
      rt.cleanup();
    }
  });

  test("clicking a tab in the tab strip switches the active file", async () => {
    const rt = bootApp({ files: { "a.md": "A body", "b.md": "B body" } });
    try {
      await rt.win.lightmdOpenFolder(rt.folderPath);
      await rt.win.lightmdOpenFile("a.md");
      await rt.win.lightmdOpenFile("b.md");
      const tabA = rt.el("editor-tabs").querySelector('[data-relative="a.md"]');
      tabA.querySelector(".tab-name").click();
      assert.equal(rt.win.lightmdWorkspace.relative, "a.md");
      assert.equal(rt.el("editor-buffer").value, "A body");
    } finally {
      rt.cleanup();
    }
  });
});

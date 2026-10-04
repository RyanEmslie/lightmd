// E2E harness: drive the real app (src/index.html + src/editor.bundle.js) in
// Playwright WebKit, the engine behind macOS WKWebView and Linux WebKitGTK.
// Run with `npm run test:e2e` (it rebuilds the bundle first).
//
//   import { launchApp } from "./helpers/app.mjs";
//
//   const app = await launchApp({ files: { "note.md": "# Hi\n" }, autosaveDelay: 100 });
//   try {
//     await app.openFolder();             // clicks #open-folder; the picker answers app.root
//     await app.openFile("note.md");      // clicks the explorer row
//     await app.type(" more");            // types at the end of .cm-content
//     await app.waitForWrite("note.md");  // resolves with the write record
//     app.files.get("note.md");           // what is on the fake disk now
//     assert.deepEqual(app.errors, []);
//   } finally {
//     await app.close();
//   }
//
// launchApp(options):
//   root           workspace folder the Open Folder picker returns
//                  (default "/tmp/lightmd-e2e"); `files`/`folders` live under it
//   files, folders, workspaces, capabilities, onInvoke
//                  seed the fake backend, createInvoke() in tests/helpers/tauri.mjs.
//                  It runs in Node; the page reaches it through a
//                  window.__TAURI__ built by buildTauriGlobals(), so core.invoke,
//                  dialog.*, opener.* and getCurrentWindow().setSize() all hit it.
//                  Plugin calls are gated by src-tauri/capabilities like Tauri's
//                  ACL; see app.backend.rejections, .dialogs, .opened, .windowCalls.
//   dialog         { open, save, confirm } answers; change them later on app.dialog
//   autosaveDelay  ms, typed into Settings > Editor > Delay after boot
//   storage        { key: value } put in localStorage before the first load
//                  (objects are JSON-encoded); reload() keeps localStorage
//   viewport       default { width: 1200, height: 800 }
//
// app:
//   page, backend, root, dialog, files (live Map of root), writes, invokes
//   errors         console errors and uncaught page errors, in order
//   openFolder(path?), openFile(relative), type(text, { at: "end" | "cursor" })
//   clickTab(relative)  clicks that file's tab in the tab strip
//   undo()         focuses the editor and presses Cmd/Ctrl+Z
//   editorText(), previewText(), isDirty()
//   settle()       wait until no IPC call is in flight, then two frames
//   waitFor(fn), waitForWrite(relative, { contents?, timeout? })
//   reload(), close()
//
// To extend: add a method below and document it here. Prefer driving real
// controls (clicks, keys, the Settings UI) over calling window.lightmd* hooks.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { webkit } from "playwright";
import { srcDir } from "../../helpers/source.mjs";
import { buildTauriGlobals, createInvoke } from "../../helpers/tauri.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Serve src/ read-only, like Tauri serves frontendDist.
function serveSrc() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = normalize(join(srcDir, path === "/" ? "index.html" : path));
    if (!file.startsWith(srcDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function initScript(storage) {
  return `(() => {
  const build = ${buildTauriGlobals.toString()};
  window.__lightmdPendingIpc = 0;
  const ipc = async (cmd, args = {}) => {
    window.__lightmdPendingIpc += 1;
    try {
      const res = await window.__lightmdIpc(cmd, args);
      if (!res.ok) throw res.error;
      if (!res.arrayBuffer) return res.value;
      const view = res.value;
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    } finally {
      window.__lightmdPendingIpc -= 1;
    }
  };
  const globals = build(ipc);
  window.__TAURI_INTERNALS__ = globals.__TAURI_INTERNALS__;
  window.__TAURI__ = globals.__TAURI__;
  try {
    if (!sessionStorage.getItem("lightmd.e2e.seeded")) {
      const seed = ${JSON.stringify(storage)};
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
      sessionStorage.setItem("lightmd.e2e.seeded", "1");
    }
  } catch {}
})();`;
}

async function waitFor(fn, { timeout = 5000, interval = 20, message = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out after ${timeout}ms waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export async function launchApp(options = {}) {
  const root = options.root || "/tmp/lightmd-e2e";
  const backend = createInvoke({
    root,
    files: options.files,
    folders: options.folders,
    workspaces: options.workspaces,
    dialog: { open: root, ...(options.dialog || {}) },
    onInvoke: options.onInvoke,
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
  });
  const storage = Object.fromEntries(
    Object.entries(options.storage || {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );

  const server = await serveSrc();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const errors = [];
  let browser = null;
  let context = null;
  let page = null;

  async function shutdown() {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  async function settle() {
    await page.waitForFunction(() => window.__lightmdPendingIpc === 0);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }

  async function boot(load) {
    await load();
    await page
      .waitForFunction(() => window.lightmdEditor && document.querySelector(".cm-content"), null, {
        timeout: 10000,
      })
      .catch((err) => {
        throw new Error(`the app did not boot: ${errors.join("; ") || err.message}`);
      });
    if (options.autosaveDelay != null) {
      await page.evaluate((ms) => {
        const input = document.getElementById("settings-autosave-delay");
        input.value = String(ms);
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, options.autosaveDelay);
    }
    await settle();
  }

  try {
    browser = await webkit.launch();
    context = await browser.newContext({ viewport: options.viewport || { width: 1200, height: 800 } });
    await context.exposeBinding("__lightmdIpc", async (_source, cmd, args) => {
      try {
        const value = await backend.invoke(cmd, args);
        // Playwright can't pass an ArrayBuffer (raw image bytes); a Uint8Array crosses fine.
        if (value instanceof ArrayBuffer) return { ok: true, value: new Uint8Array(value), arrayBuffer: true };
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: typeof error === "string" ? error : String(error?.message ?? error) };
      }
    });
    await context.addInitScript({ content: initScript(storage) });
    page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    await boot(() => page.goto(url));
  } catch (err) {
    await shutdown();
    throw err;
  }

  const app = {
    page,
    backend,
    root,
    dialog: backend.dialog,
    files: backend.files,
    writes: backend.writes,
    invokes: backend.invokes,
    errors,
    settle,
    waitFor,

    async openFolder(path = root) {
      backend.dialog.open = path;
      await page.click("#open-folder");
      await settle();
    },

    async openFile(relative) {
      const parts = relative.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = page.locator(`#file-list li[data-path=${JSON.stringify(parts.slice(0, i).join("/"))}] > details`);
        if (!(await dir.evaluate((d) => d.open))) await dir.locator("> summary").click();
      }
      await page.click(`#file-list li[data-path=${JSON.stringify(relative)}]`);
      await settle();
    },

    async type(text, { at = "end" } = {}) {
      await page.click(".cm-content");
      if (at === "end") await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type(text);
    },

    async clickTab(relative) {
      await page.click(`#editor-tabs [role="tab"][data-relative=${JSON.stringify(relative)}] .tab-name`);
      await settle();
    },

    async undo() {
      await page.click(".cm-content");
      await page.keyboard.press("ControlOrMeta+z");
    },

    editorText() {
      return page.evaluate(() => window.lightmdEditor.view.state.doc.toString());
    },

    previewText() {
      return page.locator("#preview-body").innerText();
    },

    isDirty() {
      return page.evaluate(() => !document.getElementById("dirty").hidden);
    },

    waitForWrite(relative, { contents, timeout = 5000 } = {}) {
      return waitFor(
        () =>
          backend.writes.find(
            (w) => w.relative === relative && (contents === undefined || w.contents === contents),
          ),
        { timeout, message: `a write of ${relative}` },
      );
    },

    async reload() {
      await boot(() => page.reload());
    },

    close: shutdown,
  };
  return app;
}

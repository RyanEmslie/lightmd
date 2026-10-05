import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildTauriGlobals, createInvoke } from "./helpers/tauri.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const CLICK_NAMES = [
  "handlePreviewClick",
  "onPreviewClick",
  "handlePreviewLink",
  "previewLinkClick",
];
const BIND_NAMES = ["bindPreviewLinks", "interceptPreviewLinks"];

function pickFn(mod, names) {
  if (!mod || typeof mod !== "object") return null;
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  if (mod.default && typeof mod.default === "object") {
    for (const name of names) {
      if (typeof mod.default[name] === "function") return mod.default[name];
    }
  }
  return null;
}

async function loadPreviewClickApi() {
  const names = ["preview.js", "preview.mjs"];
  for (const name of names) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    const mod = await import(pathToFileURL(p).href);
    const handle = pickFn(mod, CLICK_NAMES);
    const bind = pickFn(mod, BIND_NAMES);
    if (handle || bind) return { handle, bind };
  }
  return { handle: null, bind: null };
}

function makeAnchor(href) {
  const anchor = {
    tagName: "A",
    nodeName: "A",
    href,
    getAttribute(name) {
      return name === "href" ? href : null;
    },
    closest(sel) {
      const s = String(sel || "");
      if (/^a\b/i.test(s)) return anchor;
      return null;
    },
  };
  return anchor;
}

function makeClickEvent(anchor) {
  const event = {
    type: "click",
    target: anchor,
    currentTarget: null,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() {
      event.preventDefaultCalls += 1;
      event.defaultPrevented = true;
    },
    stopPropagation() {},
    preventDefaultCalls: 0,
  };
  return event;
}

function makePreviewRoot() {
  const listeners = [];
  return {
    id: "preview-body",
    addEventListener(type, fn) {
      listeners.push({ type: String(type), fn });
    },
    dispatchEvent(event) {
      for (const l of listeners) {
        if (l.type === event.type) l.fn.call(this, event);
      }
      return !event.defaultPrevented;
    },
  };
}

async function dispatchPreviewClick(href) {
  const api = await loadPreviewClickApi();
  assert.ok(
    api.bind || api.handle,
    "missing handlePreviewClick / bindPreviewLinks (or openPreviewLink click path)",
  );

  const backend = createInvoke();
  const prevTauri = globalThis.__TAURI__;
  globalThis.__TAURI__ = buildTauriGlobals(backend.invoke).__TAURI__;

  const anchor = makeAnchor(href);
  const event = makeClickEvent(anchor);
  try {
    if (typeof api.bind === "function") {
      const previewRoot = makePreviewRoot();
      api.bind(previewRoot);
      previewRoot.dispatchEvent(event);
    } else {
      api.handle(event);
    }
  } finally {
    if (prevTauri === undefined) delete globalThis.__TAURI__;
    else globalThis.__TAURI__ = prevTauri;
  }

  // Any IPC call counts: opener.openUrl and core.invoke both end up here.
  const openerCalls = backend.invokes.map((call) => call.args?.url ?? call.cmd);
  return {
    preventDefaultCalls: event.preventDefaultCalls,
    defaultPrevented: event.defaultPrevented,
    openerCalls,
  };
}

test('click/dispatch on preview <a href="foo.md"> and <a href="../up.md"> preventDefault and do not call opener', async () => {
  for (const href of ["foo.md", "../up.md"]) {
    const result = await dispatchPreviewClick(href);
    assert.ok(
      result.preventDefaultCalls > 0 && result.defaultPrevented,
      `preventDefault must run for href=${href} (default navigation blocked)`,
    );
    assert.equal(
      result.openerCalls.length,
      0,
      `openPreviewLink / opener must not be called for href=${href}, got ${JSON.stringify(result.openerCalls)}`,
    );
  }
});

test('click on preview <a href="//evil.com/x"> preventDefault and does not open as-is', async () => {
  const href = "//evil.com/x";
  const result = await dispatchPreviewClick(href);
  assert.ok(
    result.preventDefaultCalls > 0 && result.defaultPrevented,
    "preventDefault must run for protocol-relative href (default navigation blocked)",
  );
  assert.equal(
    result.openerCalls.some((url) => url === href),
    false,
    "opener must not be called with //evil.com/x as-is for webview nav",
  );
});

test('click on preview <a href="https://example.com"> preventDefault and calls opener', async () => {
  const href = "https://example.com";
  const result = await dispatchPreviewClick(href);
  assert.ok(
    result.preventDefaultCalls > 0 && result.defaultPrevented,
    "preventDefault must run for https://example.com",
  );
  assert.ok(
    result.openerCalls.some((url) => url === href),
    `openPreviewLink / opener must be called for ${href}, got ${JSON.stringify(result.openerCalls)}`,
  );
});

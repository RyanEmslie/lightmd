import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { createDocument, createWindow, memoryStorage } from "./helpers/dom.mjs";
import { srcDir } from "./helpers/source.mjs";
import { buildTauriGlobals, createInvoke } from "./helpers/tauri.mjs";

const KEYS = ["document", "window", "localStorage", "__TAURI__", "__lightmdKeyboardBound"];
const saved = Object.fromEntries(KEYS.map((key) => [key, globalThis[key]]));
const realConsoleError = console.error;

afterEach(() => {
  console.error = realConsoleError;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete globalThis[key];
    else globalThis[key] = saved[key];
  }
});

function captureConsoleErrors() {
  const calls = [];
  console.error = (...args) => calls.push(args);
  return calls;
}

function installApp(storage = memoryStorage()) {
  const doc = createDocument();
  const win = createWindow(doc, { storage });
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = storage;
  return doc;
}

function fresh(file, tag) {
  return import(`${pathToFileURL(join(srcDir, file)).href}?init-errors-${tag}-${Date.now()}-${Math.random()}`);
}

function mentions(calls, re) {
  return calls.some((args) => args.some((a) => re.test(String(a?.message ?? a))));
}

// A document whose lookups throw stands in for any real init bug.
function installBrokenDocument() {
  const doc = installApp();
  doc.getElementById = () => {
    throw new Error("init boom");
  };
  return doc;
}

test("errors while layout.js binds its controls reach console.error", async () => {
  installBrokenDocument();
  const calls = captureConsoleErrors();
  await fresh("layout.js", "layout");
  assert.ok(mentions(calls, /init boom/), "layout.js must not swallow init errors");
});

test("errors while settings.js binds its controls reach console.error", async () => {
  installApp();
  await fresh("settings.js", "warm"); // load its dependencies against a sane document first
  installBrokenDocument();
  const calls = captureConsoleErrors();
  await fresh("settings.js", "settings");
  assert.ok(mentions(calls, /init boom/), "settings.js must not swallow init errors");
});

test("errors while keyboard.js binds reach console.error", async () => {
  installApp();
  await fresh("keyboard.js", "warm");
  delete globalThis.__lightmdKeyboardBound;
  globalThis.window = {
    addEventListener() {
      throw new Error("init boom");
    },
  };
  const calls = captureConsoleErrors();
  await fresh("keyboard.js", "keyboard");
  assert.ok(mentions(calls, /init boom/), "keyboard.js must not swallow init errors");
});

test("editor.js leaves the layout restore to layout.js instead of running it twice", () => {
  const src = readFileSync(join(srcDir, "editor.js"), "utf8");
  assert.doesNotMatch(src, /\brestoreLayout\s*\(/, "layout.js already restores the layout when it loads");
});

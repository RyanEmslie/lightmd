import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { createDocument, createWindow, memoryStorage } from "./helpers/dom.mjs";
import { srcDir } from "./helpers/source.mjs";

const KEYS = ["document", "window", "localStorage", "lightmdSave", "lightmdFind", "__lightmdKeyboardBound"];
const saved = Object.fromEntries(KEYS.map((key) => [key, globalThis[key]]));
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete globalThis[key];
    else globalThis[key] = saved[key];
  }
  if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
  else delete globalThis.navigator;
});

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

// keyboard.js on the real markup, with navigator.platform set to `platform`.
async function bootKeyboard(platform) {
  Object.defineProperty(globalThis, "navigator", {
    value: { platform, userAgent: "" },
    configurable: true,
    writable: true,
  });
  const doc = createDocument();
  const win = createWindow(doc, { storage: memoryStorage() });
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = win.localStorage;
  delete globalThis.__lightmdKeyboardBound;
  const calls = { open: 0, save: 0, find: 0 };
  doc.getElementById("open-folder").addEventListener("click", () => {
    calls.open += 1;
  });
  globalThis.lightmdSave = () => {
    calls.save += 1;
  };
  globalThis.lightmdFind = () => {
    calls.find += 1;
  };
  const href = pathToFileURL(join(srcDir, "keyboard.js")).href;
  const mod = await import(`${href}?keyboard-platform=${Date.now()}-${Math.random()}`);
  mod.collapsePane("preview", false);
  function press(init) {
    const ev = { type: "keydown", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init };
    win.dispatchEvent(ev);
    return ev;
  }
  return { mod, calls, press };
}

test("on macOS, Cmd runs the app shortcuts", async () => {
  const { mod, calls, press } = await bootKeyboard(MAC);
  press({ key: "o", code: "KeyO", metaKey: true });
  press({ key: "s", code: "KeyS", metaKey: true });
  press({ key: "f", code: "KeyF", metaKey: true });
  press({ key: "3", code: "Digit3", metaKey: true });
  assert.deepEqual(calls, { open: 1, save: 1, find: 1 });
  assert.equal(mod.layout.open.preview, false, "Cmd+3 toggles the preview");
});

test("on macOS, Ctrl is left to CodeMirror's Mac bindings", async () => {
  const { mod, calls, press } = await bootKeyboard(MAC);
  for (const [key, code] of [
    ["o", "KeyO"],
    ["s", "KeyS"],
    ["f", "KeyF"],
    ["3", "Digit3"],
  ]) {
    const ev = press({ key, code, ctrlKey: true });
    assert.equal(!!ev.defaultPrevented, false, `Ctrl+${key} must reach the editor untouched`);
  }
  assert.deepEqual(calls, { open: 0, save: 0, find: 0 });
  assert.equal(mod.layout.open.preview, true, "Ctrl+3 must not toggle a pane on macOS");
});

test("on Windows and Linux, Ctrl runs the app shortcuts and the Super key does not", async () => {
  const { calls, press } = await bootKeyboard(LINUX);
  press({ key: "o", code: "KeyO", ctrlKey: true });
  press({ key: "o", code: "KeyO", metaKey: true });
  assert.equal(calls.open, 1);
});

test("letter shortcuts follow the typed key, so Dvorak's Cmd+O opens a folder instead of saving", async () => {
  const { calls, press } = await bootKeyboard(MAC);
  // On Dvorak the QWERTY S key types "o" and the QWERTY O key types "r".
  press({ key: "o", code: "KeyS", metaKey: true });
  assert.deepEqual(calls, { open: 1, save: 0, find: 0 });
  press({ key: "r", code: "KeyO", metaKey: true });
  assert.deepEqual(calls, { open: 1, save: 0, find: 0 }, "Cmd+R must not open a folder");
});

test("the physical key stands in when the typed key is not a Latin letter", async () => {
  const { calls, press } = await bootKeyboard(LINUX);
  press({ key: "щ", code: "KeyO", ctrlKey: true });
  assert.equal(calls.open, 1, "Ctrl+O on a Cyrillic layout still opens a folder");
});

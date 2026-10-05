import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { loadSourceFiles, root } from "./helpers/source.mjs";
import { KNOWN_COMMANDS } from "./helpers/tauri.mjs";

// The frontend may only invoke commands the Rust side registers, plus plugin
// commands. A call to anything else rejects at runtime with "Command … not
// found", which the fake backend in tests/helpers/tauri.mjs now mirrors.

const PENDING_RUST_COMMANDS = new Set([]);

function rustCommands() {
  const src = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
  const m = src.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  assert.ok(m, "src-tauri/src/lib.rs must register commands with generate_handler![...]");
  return new Set(
    m[1]
      .replace(/\/\/.*$/gm, "")
      .split(",")
      .map((s) => s.trim().split("::").pop())
      .filter(Boolean),
  );
}

function invokedCommands() {
  const found = [];
  for (const file of loadSourceFiles()) {
    if (!/\.(js|html)$/i.test(file.path)) continue;
    const re = /\binvoke\(\s*(["'`])([^"'`]+)\1/g;
    let m;
    while ((m = re.exec(file.text))) {
      found.push({ name: m[2], file: relative(root, file.path) });
    }
  }
  return found;
}

const PLUGIN_COMMANDS = new Set(KNOWN_COMMANDS.filter((cmd) => cmd.startsWith("plugin:")));

test("the scan finds the app's invoke() calls", () => {
  const names = new Set(invokedCommands().map((c) => c.name));
  for (const cmd of ["list_workspace", "read_workspace_file", "write_workspace_file"]) {
    assert.ok(names.has(cmd), `expected src/ to invoke ${cmd}; is the scan broken?`);
  }
});

test("every command src/ invokes is registered in Rust or is a known plugin command", () => {
  const rust = rustCommands();
  const unknown = invokedCommands().filter(
    ({ name }) => !rust.has(name) && !PENDING_RUST_COMMANDS.has(name) && !PLUGIN_COMMANDS.has(name),
  );
  assert.deepEqual(
    unknown.map(({ name, file }) => `${name} (${file})`),
    [],
    "these invoke() calls would reject with \"Command … not found\" in the real app",
  );
});

test("the fake backend knows no app command that Rust doesn't register", () => {
  const rust = rustCommands();
  const phantom = KNOWN_COMMANDS.filter(
    (cmd) => !cmd.startsWith("plugin:") && !rust.has(cmd) && !PENDING_RUST_COMMANDS.has(cmd),
  );
  assert.deepEqual(phantom, [], "tests/helpers/tauri.mjs KNOWN_COMMANDS must mirror lib.rs");
});

test("PENDING_RUST_COMMANDS only lists commands Rust doesn't register yet", () => {
  const rust = rustCommands();
  const stale = [...PENDING_RUST_COMMANDS].filter((cmd) => rust.has(cmd));
  assert.deepEqual(stale, [], "Rust registers these now; remove them from PENDING_RUST_COMMANDS");
});

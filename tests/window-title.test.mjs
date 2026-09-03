import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("window title is LightMD", () => {
  const confPath = join(root, "src-tauri", "tauri.conf.json");
  assert.equal(existsSync(confPath), true, "src-tauri/tauri.conf.json must exist");
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  assert.equal(conf.productName, "LightMD");
  assert.equal(conf.app.windows[0].title, "LightMD");
});

test("electron is not a dependency", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.equal("electron" in deps, false);
});


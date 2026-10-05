// The README is the install guide for a public repo: these check the facts a
// reader relies on (prerequisites, commands, privacy), not exact wording.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const readme = read("README.md");

function section(name) {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${name}\\b`, "i").test(l));
  assert.ok(start >= 0, `README must have a "${name}" section`);
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level);
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

test("README has the sections a public project needs", () => {
  for (const name of ["Features", "Install", "Update", "Usage", "Privacy", "Development", "Changelog", "License"]) {
    section(name);
  }
});

test("macOS prerequisites: Xcode Command Line Tools, Node 20+, rustup stable", () => {
  const install = section("Install");
  assert.match(install, /xcode-select --install/);
  assert.match(install, /Node\.js 20/);
  assert.match(install, /rustup default stable/);
  assert.match(install, /signing and notarization aren't required/i);
});

test("Linux prerequisites: rustup not Debian's rustc, and the Tauri 2 packages", () => {
  const install = section("Install");
  assert.match(install, /debian[^\n.]{0,80}\brustc\b[^\n.]{0,40}too old/i);
  assert.doesNotMatch(install, /apt(?:-get)?\s+install[^\n]*\brustc\b/i);
  for (const pkg of [
    "libwebkit2gtk-4.1-dev",
    "build-essential",
    "libxdo-dev",
    "libssl-dev",
    "libayatana-appindicator3-dev",
    "librsvg2-dev",
    "pkg-config",
  ]) {
    assert.ok(install.includes(pkg), `README must list ${pkg}`);
  }
});

test("build steps clone the repo and use the package scripts", () => {
  const install = section("Install");
  assert.match(install, /git clone https:\/\/github\.com\/RyanEmslie\/lightmd/);
  assert.match(install, /npm install/);
  assert.match(install, /npm run tauri build/);
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.match(scripts.tauri, /\btauri\b/);
  assert.match(scripts.build, /tauri build/);
  assert.match(scripts.dev, /tauri dev/);
});

test("update steps pull, install and rebuild", () => {
  const update = section("Update");
  assert.match(update, /git pull/);
  assert.match(update, /npm install/);
  assert.match(update, /npm run tauri build/);
});

test("README doesn't offer downloads or installers that don't exist", () => {
  assert.match(section("Install"), /no prebuilt downloads/i);
  assert.doesNotMatch(readme, /github\.com\/[^\s)]+\/releases\b/i);
});

test("privacy: no telemetry and no update check", () => {
  const privacy = section("Privacy");
  assert.match(privacy, /no telemetry/i);
  assert.match(privacy, /no update check/i);
  assert.match(privacy, /only reads and writes files in the folder you open/i);
});

test("the changelog exists and has an Unreleased section", () => {
  assert.ok(existsSync(join(root, "CHANGELOG.md")));
  assert.match(read("CHANGELOG.md"), /^## \[Unreleased\]/m);
  assert.match(readme, /\(CHANGELOG\.md\)/);
});

test("images the README shows exist in the repo", () => {
  for (const [, src] of readme.matchAll(/<img src="([^"]+)"/g)) {
    assert.ok(existsSync(join(root, src)), `missing ${src}`);
  }
});

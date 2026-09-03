import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");
const packagePath = join(root, "package.json");
const workflowsPath = join(root, ".github", "workflows");

// Mac clone-and-build docs are optional for v1 (Atrium is the daily TDD host).
// These tests require the README to document the Mac path; they do not require a Mac for v1.

function loadReadme() {
  assert.equal(existsSync(readmePath), true, "README.md must exist");
  return readFileSync(readmePath, "utf8");
}

function loadPackage() {
  assert.equal(existsSync(packagePath), true, "package.json must exist");
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function sentences(text) {
  return String(text)
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNegatedStep(sentence) {
  return /\b(not|without|later|optional|excluded|unneeded|don't|do not|out of scope|no)\b/i.test(
    sentence,
  );
}

function findMacSection(text) {
  const lines = String(text).split(/\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!m || !/\bmac(?:os)?\b/i.test(m[2])) continue;
    start = i;
    level = m[1].length;
    break;
  }
  if (start < 0) return null;
  const collected = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) break;
    collected.push(lines[i]);
  }
  return { heading: lines[start], text: collected.join("\n") };
}

test("README has a macOS / Mac section heading", () => {
  const section = findMacSection(loadReadme());
  assert.ok(
    section,
    "README must have a markdown heading for a macOS / Mac section",
  );
  assert.match(
    section.heading,
    /^#{1,6}\s+.*\bmac(?:os)?\b/i,
    "the Mac section heading must name macOS or Mac",
  );
});

test("README documents git clone of the LightMD repo", () => {
  const pkg = loadPackage();
  const text = loadReadme();
  assert.equal(typeof pkg.name, "string", "package.json name must be a string");
  assert.match(
    text,
    /git\s+clone/i,
    "README must document git clone of the LightMD repo",
  );
  const name = String(pkg.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nearby = new RegExp(
    String.raw`git\s+clone[\s\S]{0,200}${name}|${name}[\s\S]{0,200}git\s+clone`,
    "i",
  );
  assert.match(
    text,
    nearby,
    `README must git clone the ${pkg.name} repo`,
  );
});

test("README documents Xcode Command Line Tools via xcode-select not Apple Developer Program", () => {
  const text = loadReadme();
  assert.match(
    text,
    /xcode-select/i,
    "README must document Xcode Command Line Tools via xcode-select for Mac desktop Tauri",
  );
  assert.match(
    text,
    /command\s+line\s+tools/i,
    "README must name Xcode Command Line Tools (not Apple Developer Program)",
  );
  for (const s of sentences(text)) {
    if (!/apple\s+developer\s+program/i.test(s)) continue;
    if (!/xcode|command\s+line\s+tools|tauri/i.test(s)) continue;
    assert.ok(
      isNegatedStep(s),
      `Mac desktop Tauri must use xcode-select, not Apple Developer Program: ${s}`,
    );
  }
});

test("README documents Rust via rustup and Node 20+ for Mac", () => {
  const section = findMacSection(loadReadme());
  assert.ok(
    section,
    "README must have a macOS / Mac section that documents Rust via rustup and Node 20+",
  );
  assert.match(
    section.text,
    /\brustup\b/i,
    "Mac section must document Rust via rustup (Linux rustup does not count)",
  );
  assert.match(
    section.text,
    /\brust\b/i,
    "Mac section must document Rust via rustup",
  );
  assert.match(
    section.text,
    /node(?:\.js)?\s*20\s*\+/i,
    "Mac section must document Node 20+",
  );
});

test("README documents npm install, tauri dev, and tauri build on macOS", () => {
  const pkg = loadPackage();
  const scripts = pkg.scripts || {};
  assert.equal(
    typeof scripts.tauri,
    "string",
    "package.json scripts.tauri must exist",
  );
  const section = findMacSection(loadReadme());
  assert.ok(
    section,
    "README must have a macOS / Mac section that documents npm install, tauri dev, and tauri build",
  );
  assert.match(
    section.text,
    /npm\s+install/i,
    "Mac section must document npm install (Linux install/run does not count)",
  );
  assert.match(
    section.text,
    /tauri\s+dev/i,
    "Mac section must document tauri dev",
  );
  assert.match(
    section.text,
    /tauri\s+build/i,
    "Mac section must document tauri build",
  );
});

test("README documents opening a local folder of .md / .html", () => {
  const section = findMacSection(loadReadme());
  assert.ok(
    section,
    "README must document opening a local folder of .md / .html in a macOS / Mac section",
  );
  assert.match(
    section.text,
    /open(?:s|ing)?(?:\s+a)?(?:\s+local)?\s+folder/i,
    "Mac section must document opening a local folder",
  );
  assert.match(
    section.text,
    /\.md\b/i,
    "Mac section must document a folder of .md files",
  );
  assert.match(
    section.text,
    /\.html\b/i,
    "Mac section must document a folder of .html files",
  );
});

test("no GitHub Actions workflow is required", () => {
  assert.equal(
    existsSync(workflowsPath),
    false,
    "no .github/workflows directory is required (must not exist)",
  );
  const text = loadReadme();
  for (const s of sentences(text)) {
    if (!/github\s+actions|\.github\/workflows/i.test(s)) continue;
    assert.ok(
      isNegatedStep(s),
      `README must not require GitHub Actions as a step: ${s}`,
    );
  }
});

test("Apple Developer Program signing and notarization are not required steps", () => {
  const text = loadReadme();
  for (const s of sentences(text)) {
    if (
      !/apple\s+developer\s+program|\bnotariz(?:e|ed|ing|ation)\b|\bcode[\s-]?sign(?:ing|ed)?\b|\bcodesign\b/i.test(
        s,
      )
    ) {
      continue;
    }
    assert.ok(
      isNegatedStep(s),
      `Apple Developer Program / signing / notarization must not be a required step: ${s}`,
    );
  }
});

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const readmePath = join(root, "README.md");
const docsDir = join(root, "docs");
const packagePath = join(root, "package.json");
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const libPath = join(root, "src-tauri", "src", "lib.rs");

const BANNED_DEPS = [
  "sentry",
  "mixpanel",
  "segment",
  "amplitude",
  "posthog",
  "gtag",
  "google-analytics",
  "telemetry",
  "plausible",
  "umami",
];

const ANALYTICS_HOSTS = [
  "sentry.io",
  "sentry-cdn.com",
  "mixpanel.com",
  "mxpnl.com",
  "segment.com",
  "segment.io",
  "amplitude.com",
  "posthog.com",
  "google-analytics.com",
  "googletagmanager.com",
  "analytics.google.com",
  "plausible.io",
  "umami.is",
];

const NPM_DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function collectMarkdown(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectMarkdown(p, acc);
      continue;
    }
    if (/\.md$/i.test(ent.name)) acc.push(p);
  }
  return acc;
}

function loadArchitectureNotes() {
  const paths = [];
  if (existsSync(readmePath)) paths.push(readmePath);
  collectMarkdown(docsDir, paths);
  assert.ok(
    paths.length > 0,
    "README.md or docs/ architecture notes must exist to document no telemetry and local-only files",
  );
  return paths.map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
}

function documentsNoTelemetryV1(text) {
  return /no[-\s]telemetry[\s\S]{0,160}\bv1\b|\bv1\b[\s\S]{0,160}no[-\s]telemetry|without telemetry[\s\S]{0,160}\bv1\b|\bv1\b[\s\S]{0,160}without telemetry/i.test(
    text,
  );
}

function documentsLocalOnlyFileAccess(text) {
  const starts = [];
  for (const re of [/file access/gi, /opened (?:workspace )?folder/gi]) {
    let m;
    while ((m = re.exec(text))) starts.push(m.index);
  }
  return starts.some((i) => {
    const window = text.slice(Math.max(0, i - 80), i + 420);
    const opened = /opened[\s\S]{0,40}(?:workspace[\s\S]{0,20})?folder/i.test(
      window,
    );
    const config = /app config/i.test(window);
    const kinds =
      /theme/i.test(window) && /session/i.test(window) && /layout/i.test(window);
    return opened && config && kinds;
  });
}

function npmDepNames(pkg) {
  const names = [];
  for (const field of NPM_DEP_FIELDS) {
    const block = pkg[field];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      names.push(...Object.keys(block));
    }
  }
  if (Array.isArray(pkg.bundledDependencies)) {
    names.push(...pkg.bundledDependencies.map(String));
  }
  if (Array.isArray(pkg.bundleDependencies)) {
    names.push(...pkg.bundleDependencies.map(String));
  }
  return names;
}

function isDepSection(name) {
  return /(?:^|\.)(?:build-|dev-)?dependencies$/i.test(String(name).trim());
}

function cargoCrateNames(toml) {
  const names = [];
  let inDeps = false;
  for (const line of String(toml).split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      inDeps = isDepSection(section[1]);
      continue;
    }
    if (!inDeps) continue;
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (m) names.push(m[1]);
  }
  return names;
}

function isBannedDepName(name) {
  const lower = String(name).toLowerCase().replace(/^@/, "");
  const parts = lower.split(/[/._-]+/).filter(Boolean);
  return BANNED_DEPS.some((banned) => {
    if (lower === banned || parts.includes(banned)) return true;
    if (banned.includes("-") || banned.includes(".")) {
      return lower === banned || lower.includes(banned);
    }
    return false;
  });
}

function collectSrcFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectSrcFiles(p, acc);
      continue;
    }
    if (ent.name === "editor.bundle.js") continue;
    if (/\.(js|html)$/i.test(ent.name)) acc.push(p);
  }
  return acc;
}

function isLocalRelativeUrl(url) {
  const s = String(url).trim();
  if (!s) return true;
  if (/^(?:data|blob|file|tauri|asset|ipc):/i.test(s)) return true;
  if (/^https?:\/\/(?:asset\.localhost|localhost|127\.0\.0\.1)\b/i.test(s)) {
    return true;
  }
  return !/^(?:https?:|wss?:)/i.test(s);
}

function hostIsAnalytics(host) {
  const h = String(host)
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!h) return false;
  const labels = h.split(".");
  if (BANNED_DEPS.some((b) => labels.includes(b))) return true;
  return ANALYTICS_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

function urlsIn(snippet) {
  return snippet.match(/(?:https?|wss?):\/\/[^\s"'`)>\]]+/gi) || [];
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    const m = String(url).match(/^(?:https?|wss?):\/\/([^/:]+)/i);
    return m ? m[1] : "";
  }
}

function phoneHomeHits(text, file) {
  // openUrl / plugin:opener|open_url / tauri-plugin-opener are user-initiated
  // preview links, not fetch/XHR/WebSocket phone-home.
  const hits = [];
  const patterns = [
    { kind: "fetch", re: /\bfetch\s*\(/g },
    { kind: "XMLHttpRequest", re: /\bXMLHttpRequest\b/g },
    { kind: "WebSocket", re: /\bWebSocket\b/g },
  ];
  for (const { kind, re } of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const snippet = text.slice(
        Math.max(0, m.index - 120),
        Math.min(text.length, m.index + 420),
      );
      const urls = urlsIn(snippet);
      if (urls.length === 0) continue;
      for (const url of urls) {
        if (isLocalRelativeUrl(url)) continue;
        if (hostIsAnalytics(hostnameOf(url))) {
          hits.push({ file, kind, url });
        }
      }
    }
  }
  return hits;
}

function fnBody(src, name) {
  const re = new RegExp(
    String.raw`(?:pub\s+)?(?:async\s+)?fn\s+${name}\s*[\(<]`,
  );
  const m = re.exec(src);
  if (!m) return null;
  const brace = src.indexOf("{", m.index);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(brace, i + 1);
    }
  }
  return null;
}

test("README or architecture note documents no telemetry in v1 and local-only files", () => {
  const notes = loadArchitectureNotes();
  const text = notes.map((n) => n.text).join("\n\n");

  assert.ok(
    documentsNoTelemetryV1(text),
    "README.md or docs/ (e.g. docs/local-only.md) must document no telemetry in v1",
  );
  assert.ok(
    documentsLocalOnlyFileAccess(text),
    "README.md or docs/ must document that file access is the opened workspace folder plus app config (theme/session/layout)",
  );
});

test("package.json and Cargo.toml have no analytics or telemetry dependencies", () => {
  assert.equal(existsSync(packagePath), true, "package.json must exist");
  assert.equal(existsSync(cargoPath), true, "src-tauri/Cargo.toml must exist");

  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const cargo = readFileSync(cargoPath, "utf8");
  const names = [...npmDepNames(pkg), ...cargoCrateNames(cargo)];
  const banned = names.filter(isBannedDepName);
  assert.deepEqual(
    banned,
    [],
    `package.json and Cargo.toml must not depend on analytics/telemetry (${BANNED_DEPS.join(", ")}); found: ${banned.join(", ")}`,
  );
});

test("src JS has no phone-home to analytics hosts (opener https is user-initiated)", () => {
  assert.equal(existsSync(srcDir), true, "src/ must exist");
  const files = collectSrcFiles(srcDir);
  assert.ok(files.length > 0, "src/ must contain JS or HTML besides editor.bundle.js");

  const hits = [];
  for (const file of files) {
    hits.push(...phoneHomeHits(readFileSync(file, "utf8"), file));
  }
  assert.deepEqual(
    hits,
    [],
    `src JS/HTML must not fetch/XHR/WebSocket to analytics hosts (openUrl / plugin:opener|open_url / tauri-plugin-opener https is user-initiated; local relative assets are allowed): ${JSON.stringify(hits)}`,
  );
});

test("read_file write_file read_image go through confined_path", () => {
  assert.equal(existsSync(libPath), true, "src-tauri/src/lib.rs must exist");
  const src = readFileSync(libPath, "utf8");

  const readFile = fnBody(src, "read_file");
  assert.ok(readFile, "missing read_file");
  assert.match(
    readFile,
    /\bconfined_path\b/,
    "read_file must go through confined_path",
  );

  const writeFile = fnBody(src, "write_file");
  assert.ok(writeFile, "missing write_file");
  assert.match(
    writeFile,
    /\bconfined_path\b/,
    "write_file must go through confined_path",
  );

  const readImage = fnBody(src, "read_image");
  const readWorkspaceImage = fnBody(src, "read_workspace_image");
  assert.ok(
    readImage || readWorkspaceImage,
    "missing read_image or read_workspace_image",
  );
  if (readImage) {
    assert.match(
      readImage,
      /\bconfined_path\b/,
      "read_image must go through confined_path",
    );
  } else {
    assert.match(
      readWorkspaceImage,
      /\bconfined_path\b/,
      "read_workspace_image must go through confined_path",
    );
  }
});

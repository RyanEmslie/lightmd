import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const SHORT_DELAY_MS = 10_000;

function collectSource(dir) {
  const chunks = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      chunks.push(...collectSource(p));
      continue;
    }
    if (ent.name === "editor.bundle.js") continue;
    if (/\.(html|js|mjs|cjs|ts|css)$/i.test(ent.name)) {
      chunks.push(readFileSync(p, "utf8"));
    }
  }
  return chunks;
}

function loadSources() {
  assert.equal(existsSync(srcDir), true, "src/ must exist");
  const files = collectSource(srcDir);
  assert.ok(files.length > 0, "src/ must contain editor source");
  return files.join("\n");
}

function firstOf(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asConfig(value) {
  if (!value || typeof value !== "object") return null;
  if (value.autosave && typeof value.autosave === "object") {
    const nested = asConfig(value.autosave);
    if (nested) return nested;
  }
  const enabled = firstOf(
    value.enabled,
    value.on,
    typeof value.autosave === "boolean" ? value.autosave : undefined,
  );
  const delay = firstOf(
    value.delay,
    value.delayMs,
    value.timeout,
    value.ms,
    value.autosaveDelay,
    value.autoSaveDelay,
  );
  if (typeof enabled === "boolean" && typeof delay === "number" && Number.isFinite(delay)) {
    return { enabled, delay };
  }
  return null;
}

function pickAutosaveConfig(mod) {
  if (!mod || typeof mod !== "object") return null;
  const names = [
    "autosave",
    "autoSave",
    "autosaveConfig",
    "autoSaveConfig",
    "config",
    "settings",
    "defaults",
    "default",
  ];
  for (const name of names) {
    const cfg = asConfig(mod[name]);
    if (cfg) return cfg;
  }
  const enabled = firstOf(
    mod.AUTOSAVE_ENABLED,
    mod.autosaveEnabled,
    mod.autoSaveEnabled,
  );
  const delay = firstOf(
    mod.AUTOSAVE_DELAY,
    mod.autosaveDelay,
    mod.autoSaveDelay,
  );
  if (typeof enabled === "boolean" && typeof delay === "number" && Number.isFinite(delay)) {
    return { enabled, delay };
  }
  return asConfig(mod);
}

function configFromSource(src) {
  if (!/\bauto[-_]?save\b/i.test(src)) return null;

  const enabledMatch =
    src.match(/auto[-_]?save[\s\S]{0,400}?\b(?:enabled|on)\s*:\s*(true|false)/i) ||
    src.match(/\b(?:enabled|on)\s*:\s*(true|false)[\s\S]{0,400}?auto[-_]?save/i) ||
    src.match(/auto[-_]?save(?:Enabled|On|_ENABLED|_ON)?\s*[:=]\s*(true|false)/i) ||
    src.match(/auto[-_]?save\s*[:=]\s*(true|false)/i);

  const delayMatch =
    src.match(/auto[-_]?save[\s\S]{0,400}?\b(?:delay(?:Ms)?|timeout|ms)\s*:\s*(\d+)/i) ||
    src.match(/\b(?:delay(?:Ms)?|timeout|ms)\s*:\s*(\d+)[\s\S]{0,400}?auto[-_]?save/i) ||
    src.match(/auto[-_]?save(?:Delay|Timeout|_DELAY|_MS)?\s*[:=]\s*(\d+)/i);

  if (!enabledMatch || !delayMatch) return null;
  return { enabled: enabledMatch[1] === "true", delay: Number(delayMatch[1]) };
}

async function loadAutosaveConfig() {
  const names = [
    "config.js",
    "config.mjs",
    "settings.js",
    "settings.mjs",
    "autosave.js",
    "autosave.mjs",
    "editor.js",
  ];
  for (const name of names) {
    const p = join(srcDir, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const cfg = pickAutosaveConfig(mod);
      if (cfg) return cfg;
    } catch {
      // Missing export or unusable in Node: keep looking, then scan source.
    }
  }
  return configFromSource(loadSources());
}

function hasTimer(src) {
  return /\b(?:setTimeout|debounce)\s*\(/.test(src);
}

function hasWrite(src) {
  return /invoke\(\s*["'](?:write_workspace_file|write_file|write)["']/.test(src);
}

function hasAutosave(src) {
  return /\bauto[-_]?save\b/i.test(src);
}

function schedulesWriteAfterDelay(src) {
  if (!hasTimer(src) || !hasWrite(src) || !hasAutosave(src)) return false;
  const close =
    /(?:setTimeout|debounce)\s*\([\s\S]{0,1500}?invoke\(\s*["'](?:write_workspace_file|write_file|write)["']/.test(
      src,
    ) ||
    /invoke\(\s*["'](?:write_workspace_file|write_file|write)["'][\s\S]{0,1500}?(?:setTimeout|debounce)\s*\(/.test(
      src,
    );
  const named =
    /\b(?:auto[-_]?save|scheduleAutoSave|scheduleSave|debouncedSave|saveAfterDelay)\b/i.test(
      src,
    );
  return close || named;
}

function autosaveOffLeavesDirty(src) {
  if (!hasAutosave(src)) return false;
  const skipsWriteWhenOff =
    /if\s*\(\s*![^)]{0,80}?(?:auto[-_]?save|enabled|\.on)\b/i.test(src) ||
    /if\s*\([^)]{0,80}?(?:auto[-_]?save\.(?:enabled|on)|enabled)\b[^)]{0,40}\)[\s\S]{0,400}?(?:setTimeout|debounce|invoke)/i.test(
      src,
    ) ||
    /(?:auto[-_]?save\.(?:enabled|on)|(?:auto[-_]?save)Enabled)\s*(?:\?|&&)/i.test(src);
  const dirtyOnEdit =
    /setDirty\(\s*true\s*\)/.test(src) || /dirty\s*=\s*true/.test(src);
  return skipsWriteWhenOff && dirtyOnEdit;
}

function clearsDirtyAfterAutosave(src) {
  if (!hasAutosave(src) || !hasTimer(src)) return false;
  const timerClears =
    /(?:setTimeout|debounce)\s*\([\s\S]{0,1500}?(?:setDirty\(\s*false\s*\)|dirty\s*=\s*false)/.test(
      src,
    );
  const autosaveClears =
    /auto[-_]?save[\s\S]{0,1500}?(?:setDirty\(\s*false\s*\)|dirty\s*=\s*false)/i.test(
      src,
    );
  return timerClears || autosaveClears;
}

test("default autosave is on with a short delay (testable config)", async () => {
  const config = await loadAutosaveConfig();
  assert.ok(
    config,
    "missing autosave config (JS object/export with delay or off)",
  );
  assert.equal(config.enabled, true, "default autosave must be on");
  assert.ok(
    Number.isFinite(config.delay) && config.delay > 0 && config.delay <= SHORT_DELAY_MS,
    "default autosave delay must be short",
  );
});

test("autosave on: an edit schedules a write of the editor buffer after the delay without clicking Save", () => {
  const src = loadSources();
  assert.ok(
    schedulesWriteAfterDelay(src),
    "missing setTimeout/debounce that writes the editor buffer (write_workspace_file / write_file) after the delay without clicking Save",
  );
});

test("autosave off leaves dirty (no write while off)", () => {
  const src = loadSources();
  assert.ok(
    autosaveOffLeavesDirty(src),
    "autosave off must leave dirty (no write while off)",
  );
});

test("dirty clears after a successful autosave", () => {
  const src = loadSources();
  assert.ok(
    clearsDirtyAfterAutosave(src),
    "dirty must clear after a successful autosave",
  );
});

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { palettes } from "../src/palettes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const PALETTE_NAMES = Object.keys(palettes);

const CONTRAST_EXPORTS = ["contrastRatio", "contrast", "getContrastRatio"];

function collectJs(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectJs(p, acc);
      continue;
    }
    if (ent.name === "editor.bundle.js" || ent.name === "editor.js") continue;
    if (/\.js$/i.test(ent.name)) acc.push(p);
  }
  return acc;
}

async function loadContrastRatio() {
  assert.equal(existsSync(srcDir), true, "src/ must exist");
  let contrastRatio;
  for (const p of collectJs(srcDir)) {
    try {
      const mod = await import(pathToFileURL(p).href);
      for (const name of CONTRAST_EXPORTS) {
        if (typeof mod[name] === "function") {
          contrastRatio = mod[name];
          break;
        }
      }
      if (typeof contrastRatio === "function") break;
    } catch {
      // DOM or otherwise unusable in Node: keep looking.
    }
  }
  assert.equal(typeof contrastRatio, "function", "src must export contrastRatio");
  return contrastRatio;
}

test("src exports contrastRatio for palette checks", async () => {
  await loadContrastRatio();
});

test("every palette --fg on --bg is at least 4.5:1", async () => {
  const contrastRatio = await loadContrastRatio();
  for (const name of PALETTE_NAMES) {
    const palette = palettes[name];
    assert.ok(palette, `missing named palette ${name}`);
    const ratio = contrastRatio(palette["--fg"], palette["--bg"]);
    assert.ok(
      Number(ratio) >= 4.5,
      `${name} --fg on --bg contrastRatio must be >= 4.5 (got ${ratio})`,
    );
  }
});

test("High Contrast Light contrast is greater than Absolutely Light", async () => {
  const contrastRatio = await loadContrastRatio();
  const hc = palettes["High Contrast Light"];
  const light = palettes["Absolutely Light"];
  assert.ok(hc && light, "Absolutely Light and High Contrast Light palettes must exist");
  assert.ok(
    contrastRatio(hc["--fg"], hc["--bg"]) >
      contrastRatio(light["--fg"], light["--bg"]),
    "High Contrast Light --fg on --bg must exceed Absolutely Light --fg on --bg",
  );
});

test("High Contrast Dark contrast is greater than Codex Dark", async () => {
  const contrastRatio = await loadContrastRatio();
  const hc = palettes["High Contrast Dark"];
  const dark = palettes["Codex Dark"];
  assert.ok(hc && dark, "Codex Dark and High Contrast Dark palettes must exist");
  assert.ok(
    contrastRatio(hc["--fg"], hc["--bg"]) >
      contrastRatio(dark["--fg"], dark["--bg"]),
    "High Contrast Dark --fg on --bg must exceed Codex Dark --fg on --bg",
  );
});

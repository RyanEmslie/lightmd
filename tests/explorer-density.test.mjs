import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "index.html");

function loadHtml() {
  assert.equal(existsSync(htmlPath), true, "src/index.html must exist");
  return readFileSync(htmlPath, "utf8");
}

function explorerHtml(html) {
  const tagged = html.match(
    /<(aside|div|nav|section)\b[^>]*\bid=["']explorer["'][^>]*>[\s\S]*?<\/\1>/i,
  );
  if (tagged) {
    return tagged[0];
  }
  const start = html.search(/\bid=["']explorer["']/i);
  assert.ok(start >= 0, "missing #explorer");
  return html.slice(start);
}

function hasChevron(html) {
  if (/chevron/i.test(html)) return true;
  if (/<(?:details|summary)\b/i.test(html)) return true;
  if (/createElement\(\s*["'](?:details|summary)["']/i.test(html)) return true;
  if (/[▸▾►▼▶▷▻▹▿]/.test(html)) return true;
  if (
    /content\s*:\s*["'](?:\\25[bB][68AEaeCc]|\\203[aA]|\\232[aA]|[<>])["']/.test(
      html,
    )
  ) {
    return true;
  }
  return false;
}

test("explorer rows height 28px", () => {
  const html = loadHtml();
  assert.ok(
    /(?:min-height|height|line-height)\s*[:=]\s*["']?28px/.test(html),
    "explorer rows must be 28px",
  );
});

test("indent 8px per level", () => {
  const html = loadHtml();
  const css =
    /(?:padding-left|padding-inline-start|margin-left|margin-inline-start|--(?:indent|level-indent|tree-indent))\s*[:=]\s*["']?(?:calc\([^;]*8px[^;]*\)|8px)/i.test(
      html,
    );
  const js =
    /(?:paddingLeft|paddingInlineStart)\b/.test(html) &&
    /(?:\*\s*8|8\s*\*)/.test(html);
  assert.ok(css || js, "folder indent must be 8px per level");
});

test("spacing unit 8px", () => {
  const html = loadHtml();
  assert.ok(
    /(?:--(?:space|spacing|unit)\s*:\s*8px|(?:padding|margin|gap)[^;{]*8px)/.test(
      html,
    ),
    "spacing unit must be 8px",
  );
});

test("chevrons only (no icon font/pack: no font-awesome, material icons, icon class on rows)", () => {
  const html = loadHtml();
  assert.equal(/font-?awesome/i.test(html), false, "no font-awesome");
  assert.equal(/material[-_]?icons/i.test(html), false, "no material icons");
  const explorer = explorerHtml(html);
  assert.equal(
    /<(?:li|div|span|button|a|summary)\b[^>]*class=["'][^"']*\bicon\b/i.test(
      explorer,
    ),
    false,
    "no icon class on explorer rows",
  );
  assert.ok(hasChevron(html), "collapse must use a chevron");
});

test("folders are expandable (details/summary or aria-expanded chevron)", () => {
  const html = loadHtml();
  const details =
    /<details\b|createElement\(\s*["']details["']/i.test(html) &&
    /<summary\b|createElement\(\s*["']summary["']/i.test(html);
  const aria = /aria-expanded|ariaExpanded/i.test(html);
  assert.ok(
    details || aria,
    "folders must be expandable (details/summary or aria-expanded chevron)",
  );
});

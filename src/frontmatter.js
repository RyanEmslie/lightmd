const OPEN_FENCE = /^---[ \t]*\r?\n/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;
// A top-level `key:` (or `key: value`) line; `https://x` is not one.
const KEY_LINE = /^[^\s#:-][^:]*:(?:\s|$)/;

export function parseFrontmatter(source) {
  let text = source == null ? "" : String(source);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const none = { frontmatter: {}, body: text, hasFrontmatter: false };
  const open = OPEN_FENCE.exec(text);
  if (!open) return none;

  const lines = [];
  let pos = open[0].length;
  for (;;) {
    const nl = text.indexOf("\n", pos);
    const line = text.slice(pos, nl === -1 ? text.length : nl).replace(/\r$/, "");
    const next = nl === -1 ? text.length : nl + 1;
    if (CLOSE_FENCE.test(line)) {
      // An empty block is fine; otherwise it needs a key, or it is a document
      // that opens with a horizontal rule.
      if (lines.some((l) => l.trim()) && !lines.some((l) => KEY_LINE.test(l))) {
        return none;
      }
      return {
        frontmatter: parseYaml(lines.join("\n")),
        body: text.slice(next),
        hasFrontmatter: true,
      };
    }
    if (nl === -1) return none;
    lines.push(line);
    pos = next;
  }
}

function parseYaml(yaml) {
  const data = {};
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cut = line.indexOf(":");
    if (cut <= 0) continue;
    const key = line.slice(0, cut).trim();
    if (!key) continue;
    let value = line.slice(cut + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return data;
}

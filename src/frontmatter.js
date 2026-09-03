export function parseFrontmatter(source) {
  const text = source == null ? "" : String(source);
  if (!text.startsWith("---")) {
    return { frontmatter: {}, body: text, hasFrontmatter: false };
  }

  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: {}, body: text, hasFrontmatter: false };
  }

  return {
    frontmatter: parseYaml(match[1]),
    body: text.slice(match[0].length),
    hasFrontmatter: true,
  };
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

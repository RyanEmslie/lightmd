const TOKEN_NAMES = [
  "--bg",
  "--bg-elevated",
  "--fg",
  "--fg-muted",
  "--border",
  "--accent",
  "--danger",
  "--h1",
  "--h2",
  "--h3",
  "--link",
  "--code",
];

function tokens(bg, bgElevated, fg, fgMuted, border, accent, danger, preview) {
  return {
    "--bg": bg,
    "--bg-elevated": bgElevated,
    "--fg": fg,
    "--fg-muted": fgMuted,
    "--border": border,
    "--accent": accent,
    "--danger": danger,
    "--h1": preview.h1,
    "--h2": preview.h2,
    "--h3": preview.h3,
    "--link": preview.link,
    "--code": preview.code,
  };
}

export const palettes = {
  Light: tokens(
    "#ffffff",
    "#f3f3f3",
    "#333333",
    "#6a6a6a",
    "#e5e5e5",
    "#007acc",
    "#e51400",
    { h1: "#1a365d", h2: "#1e4e8c", h3: "#2b6cb0", link: "#0b57d0", code: "#a31515" },
  ),
  Dark: tokens(
    "#1a1a1a",
    "#242424",
    "#e6e6e6",
    "#9a9a9a",
    "#3a3a3a",
    "#4ea1ff",
    "#ff6b6b",
    { h1: "#8ec8ff", h2: "#6cb6ff", h3: "#4ea1ff", link: "#79b8ff", code: "#e2c08d" },
  ),
  "High Contrast Light": tokens(
    "#ffffff",
    "#f0f0f0",
    "#000000",
    "#444444",
    "#000000",
    "#0000ee",
    "#d00000",
    { h1: "#000066", h2: "#0000aa", h3: "#000080", link: "#0000ee", code: "#800000" },
  ),
  "High Contrast Dark": tokens(
    "#000000",
    "#0a0a0a",
    "#ffffff",
    "#c0c0c0",
    "#ffffff",
    "#ffff00",
    "#ff2020",
    { h1: "#ffff00", h2: "#00ffff", h3: "#7fff00", link: "#66b3ff", code: "#ffd000" },
  ),
  "Dark+": tokens(
    "#1e1e1e",
    "#252526",
    "#d4d4d4",
    "#9d9d9d",
    "#3c3c3c",
    "#007acc",
    "#f48771",
    { h1: "#569cd6", h2: "#4ec9b0", h3: "#c586c0", link: "#3794ff", code: "#ce9178" },
  ),
  "Solarized Light": tokens(
    "#fdf6e3",
    "#eee8d5",
    "#586e75",
    "#93a1a1",
    "#eee8d5",
    "#268bd2",
    "#dc322f",
    { h1: "#cb4b16", h2: "#268bd2", h3: "#6c71c4", link: "#268bd2", code: "#d33682" },
  ),
  "Solarized Dark": tokens(
    "#002b36",
    "#073642",
    "#839496",
    "#586e75",
    "#073642",
    "#268bd2",
    "#dc322f",
    { h1: "#cb4b16", h2: "#268bd2", h3: "#859900", link: "#268bd2", code: "#2aa198" },
  ),
  Monokai: tokens(
    "#272822",
    "#3e3d32",
    "#f8f8f2",
    "#75715e",
    "#3e3d32",
    "#66d9ef",
    "#f92672",
    { h1: "#f92672", h2: "#a6e22e", h3: "#ae81ff", link: "#66d9ef", code: "#e6db74" },
  ),
};

export const theme = {
  editorTheme: "Dark+",
  previewTheme: "Dark",
  chromeFollowsEditor: true,
};

export function setChromeFollowsEditor(follows, shell) {
  theme.chromeFollowsEditor = !!follows;
  if (!theme.chromeFollowsEditor) {
    const name = shell === "Light" || shell === "light" ? "Light" : "Dark";
    theme.chromeTheme = name;
  }
  applyTheme();
}

function hexLuminance(color) {
  const hex = String(color || "").replace("#", "");
  if (hex.length !== 6) return 0;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function applyPalette(el, palette) {
  if (!el || !palette) return;
  for (const name of TOKEN_NAMES) {
    const value = palette[name];
    if (typeof value === "string") el.style.setProperty(name, value);
  }
  el.style.colorScheme = hexLuminance(palette["--bg"]) > 140 ? "light" : "dark";
}

export function applyTheme() {
  const d = typeof globalThis.document !== "undefined" ? globalThis.document : null;
  if (!d) return;
  const editorPal = palettes[theme.editorTheme];
  const previewPal = palettes[theme.previewTheme];
  const chromePal = theme.chromeFollowsEditor
    ? editorPal
    : palettes[theme.chromeTheme] || palettes.Dark;
  if (chromePal) {
    applyPalette(d.documentElement, chromePal);
    applyPalette(d.body, chromePal);
    applyPalette(d.getElementById("explorer"), chromePal);
  }
  applyPalette(d.getElementById("editor"), editorPal);
  applyPalette(d.getElementById("preview"), previewPal);
}

export function setEditorTheme(name) {
  theme.editorTheme = name;
  applyTheme();
}

export function setPreviewTheme(name) {
  theme.previewTheme = name;
  applyTheme();
}

applyTheme();

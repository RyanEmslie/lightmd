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

function fromCodex(bg, surface, fg, fgMuted, accent, danger, preview) {
  return tokens(bg, surface, fg, fgMuted, surface, accent, danger, preview);
}

export const palettes = {
  "Absolutely Light": fromCodex(
    "#f9f9f7",
    "#ffffff",
    "#2d2d2b",
    "#898987",
    "#cc7d5e",
    "#e03131",
    { h1: "#a75d44", h2: "#cc7d5e", h3: "#2f9e44", link: "#cc7d5e", code: "#a75d44" },
  ),
  "Ayu Dark": fromCodex(
    "#0f1419",
    "#171b24",
    "#e6e1cf",
    "#85857d",
    "#ffb454",
    "#f26d78",
    { h1: "#d2a6ff", h2: "#ffb454", h3: "#7fd962", link: "#ffb454", code: "#d2a6ff" },
  ),
  "Ayu Light": fromCodex(
    "#fcfcfc",
    "#ffffff",
    "#5c6166",
    "#a4a7aa",
    "#f29718",
    "#f07171",
    { h1: "#399ee6", h2: "#f29718", h3: "#6cbf43", link: "#f29718", code: "#399ee6" },
  ),
  "Catppuccin Latte": fromCodex(
    "#eff1f5",
    "#e6e9ef",
    "#4c4f69",
    "#9598a8",
    "#1e66f5",
    "#d20f39",
    { h1: "#8839ef", h2: "#1e66f5", h3: "#40a02b", link: "#1e66f5", code: "#8839ef" },
  ),
  "Catppuccin Mocha": fromCodex(
    "#1e1e2e",
    "#313244",
    "#cdd6f4",
    "#7e839b",
    "#89b4fa",
    "#f38ba8",
    { h1: "#cba6f7", h2: "#89b4fa", h3: "#a6e3a1", link: "#89b4fa", code: "#cba6f7" },
  ),
  "Codex Dark": fromCodex(
    "#181818",
    "#2d2d2b",
    "#ffffff",
    "#979797",
    "#339cff",
    "#ff5f57",
    { h1: "#7c8cff", h2: "#339cff", h3: "#34c759", link: "#339cff", code: "#7c8cff" },
  ),
  Dracula: fromCodex(
    "#282a36",
    "#44475a",
    "#f8f8f2",
    "#9a9b9d",
    "#bd93f9",
    "#ff5555",
    { h1: "#bd93f9", h2: "#bd93f9", h3: "#50fa7b", link: "#bd93f9", code: "#bd93f9" },
  ),
  "Everforest Dark": fromCodex(
    "#2b3339",
    "#374145",
    "#d3c6aa",
    "#878477",
    "#a7c080",
    "#e67e80",
    { h1: "#d699b6", h2: "#a7c080", h3: "#a7c080", link: "#a7c080", code: "#d699b6" },
  ),
  "Everforest Light": fromCodex(
    "#fdf6e3",
    "#f4f0d9",
    "#5c6a72",
    "#a4a9a5",
    "#93b259",
    "#f85552",
    { h1: "#df69ba", h2: "#93b259", h3: "#8da101", link: "#93b259", code: "#df69ba" },
  ),
  "GitHub Dark": fromCodex(
    "#0d1117",
    "#161b22",
    "#c9d1d9",
    "#747b82",
    "#58a6ff",
    "#f85149",
    { h1: "#a371f7", h2: "#58a6ff", h3: "#3fb950", link: "#58a6ff", code: "#a371f7" },
  ),
  "GitHub Light": fromCodex(
    "#ffffff",
    "#f6f8fa",
    "#1f2328",
    "#848689",
    "#0969da",
    "#cf222e",
    { h1: "#8250df", h2: "#0969da", h3: "#1a7f37", link: "#0969da", code: "#8250df" },
  ),
  "Gruvbox Dark": fromCodex(
    "#282828",
    "#3c3836",
    "#ebdbb2",
    "#938a74",
    "#d79921",
    "#cc241d",
    { h1: "#b16286", h2: "#d79921", h3: "#98971a", link: "#d79921", code: "#b16286" },
  ),
  "Gruvbox Light": fromCodex(
    "#fbf1c7",
    "#ebdbb2",
    "#3c3836",
    "#928b77",
    "#d79921",
    "#cc241d",
    { h1: "#b16286", h2: "#d79921", h3: "#98971a", link: "#d79921", code: "#b16286" },
  ),
  "Material Lighter": fromCodex(
    "#fafafa",
    "#ffffff",
    "#546e7a",
    "#9fadb4",
    "#7c4dff",
    "#ff5370",
    { h1: "#c792ea", h2: "#7c4dff", h3: "#91b859", link: "#7c4dff", code: "#c792ea" },
  ),
  "Material Ocean": fromCodex(
    "#263238",
    "#2e3c43",
    "#eeffff",
    "#94a3a5",
    "#82aaff",
    "#f07178",
    { h1: "#c792ea", h2: "#82aaff", h3: "#c3e88d", link: "#82aaff", code: "#c792ea" },
  ),
  Monokai: fromCodex(
    "#272822",
    "#3e3d32",
    "#f8f8f2",
    "#9a9a94",
    "#fd971f",
    "#f92672",
    { h1: "#ae81ff", h2: "#fd971f", h3: "#a6e22e", link: "#fd971f", code: "#ae81ff" },
  ),
  "Night Owl": fromCodex(
    "#011627",
    "#1d3b53",
    "#d6deeb",
    "#768493",
    "#82aaff",
    "#ef5350",
    { h1: "#c792ea", h2: "#82aaff", h3: "#22da6e", link: "#82aaff", code: "#c792ea" },
  ),
  Nord: fromCodex(
    "#2e3440",
    "#3b4252",
    "#eceff4",
    "#969ba3",
    "#88c0d0",
    "#bf616a",
    { h1: "#b48ead", h2: "#88c0d0", h3: "#a3be8c", link: "#88c0d0", code: "#b48ead" },
  ),
  "One Dark": fromCodex(
    "#282c34",
    "#353b45",
    "#abb2bf",
    "#707680",
    "#61afef",
    "#e06c75",
    { h1: "#c678dd", h2: "#61afef", h3: "#98c379", link: "#61afef", code: "#c678dd" },
  ),
  Poimandres: fromCodex(
    "#1b1e28",
    "#303340",
    "#e4f0fb",
    "#8a929c",
    "#add7ff",
    "#d0679d",
    { h1: "#fae4fc", h2: "#add7ff", h3: "#5de4c7", link: "#add7ff", code: "#fae4fc" },
  ),
  "Rosé Pine": fromCodex(
    "#191724",
    "#26233a",
    "#e0def4",
    "#868496",
    "#c4a7e7",
    "#eb6f92",
    { h1: "#c4a7e7", h2: "#c4a7e7", h3: "#9ccfd8", link: "#c4a7e7", code: "#c4a7e7" },
  ),
  "Rosé Pine Dawn": fromCodex(
    "#faf4ed",
    "#fffaf3",
    "#575279",
    "#a09bad",
    "#d7827e",
    "#b4637a",
    { h1: "#907aa9", h2: "#d7827e", h3: "#56949f", link: "#d7827e", code: "#907aa9" },
  ),
  "Solarized Dark": fromCodex(
    "#002b36",
    "#073642",
    "#839496",
    "#48656b",
    "#268bd2",
    "#dc322f",
    { h1: "#6c71c4", h2: "#268bd2", h3: "#859900", link: "#268bd2", code: "#6c71c4" },
  ),
  "Solarized Light": fromCodex(
    "#fdf6e3",
    "#eee8d5",
    "#586e75",
    "#a2aba6",
    "#268bd2",
    "#dc322f",
    { h1: "#6c71c4", h2: "#268bd2", h3: "#859900", link: "#268bd2", code: "#6c71c4" },
  ),
  "Tokyo Day": fromCodex(
    "#e6e7ed",
    "#dfe1e8",
    "#343b59",
    "#84889c",
    "#2959aa",
    "#8c4351",
    { h1: "#5a4a78", h2: "#2959aa", h3: "#587539", link: "#2959aa", code: "#5a4a78" },
  ),
  "Tokyo Night": fromCodex(
    "#1a1b26",
    "#24283b",
    "#c0caf5",
    "#757b98",
    "#7aa2f7",
    "#f7768e",
    { h1: "#bb9af7", h2: "#7aa2f7", h3: "#9ece6a", link: "#7aa2f7", code: "#bb9af7" },
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
};

const THEME_ALIASES = {
  Light: "Absolutely Light",
  Dark: "Codex Dark",
  "Dark+": "Codex Dark",
};

export function resolveThemeName(name) {
  if (Object.prototype.hasOwnProperty.call(palettes, name)) return name;
  return THEME_ALIASES[name] || null;
}

export const theme = {
  name: "Tokyo Night",
};

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
  applyPalette(
    d.documentElement,
    palettes[theme.name] || palettes["Tokyo Night"],
  );
}

function syncThemeSelects(name) {
  const d = typeof globalThis.document !== "undefined" ? globalThis.document : null;
  if (!d || typeof d.getElementById !== "function") return;
  for (const id of ["theme", "settings-theme"]) {
    const el = d.getElementById(id);
    if (el) el.value = name;
  }
}

export function setTheme(name) {
  const resolved = resolveThemeName(name);
  if (!resolved) return;
  theme.name = resolved;
  applyTheme();
  syncThemeSelects(name);
  try {
    globalThis.lightmdPersistSession?.({ theme: name });
  } catch {
    // session module optional
  }
}

applyTheme();

export const autosave = {
  enabled: true,
  delay: 1000,
};

const SAVE_FAILED = "Save failed";
const SAVE_FAILED_SUFFIX = " — save failed";

function markClean() {
  const setDirty = typeof window !== "undefined" ? window.lightmdSetDirty : null;
  if (typeof setDirty === "function") {
    setDirty(false);
  }
}

function doc() {
  return typeof globalThis.document !== "undefined" ? globalThis.document : null;
}

function showSaveError() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const pathEl = d.getElementById("status-path");
  const strip = d.getElementById("status-strip");
  if (pathEl) {
    pathEl.dataset.error = "save-failed";
    pathEl.title = SAVE_FAILED;
    if (typeof pathEl.setAttribute === "function") {
      pathEl.setAttribute("aria-live", "polite");
    }
    const text = String(pathEl.textContent || "").trim();
    if (!/save failed/i.test(text)) {
      pathEl.textContent = text ? `${text}${SAVE_FAILED_SUFFIX}` : SAVE_FAILED;
    }
  }
  if (strip) {
    strip.dataset.error = "save-failed";
    strip.title = SAVE_FAILED;
    if (typeof strip.setAttribute === "function") {
      strip.setAttribute("aria-live", "polite");
    }
  }
}

function clearSaveError() {
  const d = doc();
  if (!d || typeof d.getElementById !== "function") return;
  const pathEl = d.getElementById("status-path");
  const strip = d.getElementById("status-strip");
  if (pathEl) {
    delete pathEl.dataset.error;
    pathEl.title = "";
    if (typeof pathEl.removeAttribute === "function") {
      pathEl.removeAttribute("data-error");
      pathEl.removeAttribute("title");
      pathEl.removeAttribute("aria-live");
    }
    pathEl.textContent = String(pathEl.textContent || "").replace(
      /\s+— save failed$/i,
      "",
    );
  }
  if (strip) {
    delete strip.dataset.error;
    strip.title = "";
    if (typeof strip.removeAttribute === "function") {
      strip.removeAttribute("data-error");
      strip.removeAttribute("title");
    }
  }
}

let autosaveTimer = null;
let autosaveSeq = 0;

export function cancelAutosave() {
  if (autosaveTimer != null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  autosaveSeq += 1;
}

export function scheduleAutoSave() {
  cancelAutosave();
  if (!autosave.enabled) return;
  const seq = ++autosaveSeq;
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
    const ctx = typeof window !== "undefined" ? window.lightmdWorkspace : null;
    if (!tauri || !ctx || !ctx.path || !ctx.relative) return;
    const path = ctx.path;
    const relative = ctx.relative;
    const contents = ctx.contents;
    try {
      await tauri.core.invoke("write_workspace_file", {
        path,
        relative,
        contents,
      });
    } catch {
      if (seq === autosaveSeq) showSaveError();
      return;
    }
    if (seq !== autosaveSeq) return;
    clearSaveError();
    markClean();
  }, autosave.delay);
}

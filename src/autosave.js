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

export function showSaveError() {
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

export function clearSaveError() {
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
    // The app saves its active tab itself (window.lightmdAutosaveWrite in
    // index.html), so the right tab is marked clean and errors are shown.
    const writeActive = typeof window !== "undefined" ? window.lightmdAutosaveWrite : null;
    if (typeof writeActive === "function") {
      try {
        await writeActive();
      } catch {
        showSaveError();
      }
      return;
    }
    const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
    const ctx = typeof window !== "undefined" ? window.lightmdWorkspace : null;
    // root is the active document's folder; path the explorer's.
    const path = ctx && (ctx.root || ctx.path);
    if (!tauri || !path || !ctx.relative) return;
    const relative = ctx.relative;
    const contents = ctx.contents;
    try {
      await tauri.core.invoke("write_workspace_file", {
        path,
        relative,
        contents,
      });
    } catch {
      // Even if another save was scheduled since: this edit never reached disk.
      showSaveError();
      return;
    }
    if (seq !== autosaveSeq) return;
    clearSaveError();
    markClean();
  }, autosave.delay);
}

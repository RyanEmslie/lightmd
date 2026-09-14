export function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      const k = String(key);
      return map.has(k) ? map.get(k) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

function matchesSelector(node, sel) {
  const want = String(sel || "");
  if (!want) return false;
  if (want.startsWith("#")) return node.id === want.slice(1);
  if (want.startsWith(".")) {
    return String(node.className || "")
      .split(/\s+/)
      .includes(want.slice(1));
  }
  const attr = want.match(
    /^([a-zA-Z][\w-]*)\[([^=\]]+)=["']?([^"'\]]*)["']?\]$/,
  );
  if (attr) {
    const [, tag, key, val] = attr;
    if (String(node.tagName || "") !== tag.toUpperCase()) return false;
    if (key.startsWith("data-")) {
      const dk = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return String(node.dataset?.[dk] ?? "") === val;
    }
    return (
      (typeof node.getAttribute === "function"
        ? node.getAttribute(key)
        : null) === val
    );
  }
  if (want === "*" || String(node.tagName || "") === want.toUpperCase()) {
    return true;
  }
  return false;
}

export function mockEl(id = "", tag = "div") {
  const listeners = {};
  const el = {
    id,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    value: tag === "select" ? "name" : tag === "textarea" ? "" : "",
    checked: tag === "input",
    hidden: id === "dirty" || id === "html-viewer" || id === "html-js-warn",
    disabled: false,
    textContent: "",
    innerHTML: "",
    inner: "",
    title: "",
    className: "",
    type: tag === "button" ? "button" : tag === "input" ? "checkbox" : "",
    srcdoc: "",
    children: [],
    parentNode: null,
    dataset: {},
    attributes: {},
    style: {},
    classList: {
      add(name) {
        const parts = String(el.className || "")
          .split(/\s+/)
          .filter(Boolean);
        if (!parts.includes(name)) parts.push(name);
        el.className = parts.join(" ");
      },
      remove(name) {
        el.className = String(el.className || "")
          .split(/\s+/)
          .filter((p) => p && p !== name)
          .join(" ");
      },
      toggle(name, force) {
        const has = el.classList.contains(name);
        const on = force == null ? !has : !!force;
        if (on) el.classList.add(name);
        else el.classList.remove(name);
        return on;
      },
      contains(name) {
        return String(el.className || "")
          .split(/\s+/)
          .includes(name);
      },
    },
    addEventListener(type, fn) {
      if (typeof fn !== "function") return;
      (listeners[String(type)] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[String(type)];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(event) {
      const type = event?.type ?? event;
      const ev =
        event && typeof event === "object"
          ? event
          : { type, target: el, preventDefault() {}, stopPropagation() {} };
      if (ev.target == null) ev.target = el;
      ev.currentTarget = el;
      const results = [];
      for (const fn of listeners[String(type)] || []) {
        results.push(fn.call(el, ev));
      }
      el._lastDispatch = results;
      return !ev.defaultPrevented;
    },
    click() {
      return el.dispatchEvent({
        type: "click",
        bubbles: true,
        target: el,
        preventDefault() {},
        stopPropagation() {},
      });
    },
    focus() {
      el._focused = true;
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    append(...nodes) {
      for (const n of nodes) el.appendChild(n);
    },
    replaceChildren(...nodes) {
      for (const c of el.children) c.parentNode = null;
      el.children = [];
      el.innerHTML = "";
      el.textContent = "";
      for (const n of nodes) el.appendChild(n);
    },
    insertAdjacentHTML(position, html) {
      const chunk = String(html ?? "");
      if (String(position) === "afterbegin") {
        el.innerHTML = chunk + String(el.innerHTML || "");
      } else {
        el.innerHTML = String(el.innerHTML || "") + chunk;
      }
    },
    contains(node) {
      if (node === el) return true;
      for (const c of el.children) {
        if (c === node || (typeof c.contains === "function" && c.contains(node))) {
          return true;
        }
      }
      return false;
    },
    closest(sel) {
      const want = String(sel || "");
      let n = el;
      while (n) {
        if (matchesSelector(n, want)) return n;
        n = n.parentNode;
      }
      return null;
    },
    setAttribute(name, value) {
      const key = String(name);
      el.attributes[key] = String(value);
      if (key === "id") el.id = String(value);
      if (key === "hidden") el.hidden = true;
      if (key === "title") el.title = String(value);
      if (key === "class") el.className = String(value);
      if (key.startsWith("data-")) {
        const dk = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[dk] = String(value);
      }
    },
    getAttribute(name) {
      const key = String(name);
      if (Object.prototype.hasOwnProperty.call(el.attributes, key)) {
        return el.attributes[key];
      }
      if (key === "id") return el.id || null;
      if (key === "title") return el.title || null;
      if (key === "class") return el.className || null;
      return null;
    },
    removeAttribute(name) {
      delete el.attributes[name];
      if (name === "hidden") el.hidden = false;
      if (name === "title") el.title = "";
      if (name === "sandbox") delete el.attributes.sandbox;
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (matchesSelector(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
  };
  if (id) el.attributes.id = String(id);
  return el;
}

export function installStubGlobals() {
  if (!globalThis.document) {
    globalThis.document = {
      getElementById() {
        return null;
      },
      createElement(tag) {
        return mockEl("", tag);
      },
      createElementNS(_ns, tag) {
        return mockEl("", tag);
      },
    };
  }
  if (!globalThis.window) globalThis.window = globalThis;
  if (
    !globalThis.localStorage ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    globalThis.localStorage = memoryStorage();
  }
}

export function installFakeTimers() {
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  const pending = new Map();
  let nextId = 1;
  globalThis.setTimeout = function (fn, _ms, ...args) {
    const id = nextId++;
    pending.set(id, { fn, args });
    return id;
  };
  globalThis.clearTimeout = function (id) {
    pending.delete(id);
  };
  return {
    async flush() {
      const jobs = [...pending.values()];
      pending.clear();
      await Promise.all(
        jobs.map((job) => Promise.resolve().then(() => job.fn(...job.args))),
      );
    },
    restore() {
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
      pending.clear();
    },
  };
}

export async function clickAndAwait(el) {
  el.click();
  const results = el._lastDispatch || [];
  await Promise.all(results.filter((r) => r && typeof r.then === "function"));
}

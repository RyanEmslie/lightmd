// A small fake DOM for `node --test`.
//
// Elements form a real tree (parentNode, childNodes with text nodes, children),
// events bubble and capture, selectors support compound/attribute/descendant/
// child forms, and innerHTML / insertAdjacentHTML parse into real elements.
//
// createDocument() parses src/index.html, so getElementById() only finds ids
// that exist in the markup or that the app creates and attaches at runtime.
// mockEl() makes a detached element for module-level unit tests.
import { loadHtml } from "./source.mjs";

export const SVG_NS = "http://www.w3.org/2000/svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const REFLECTED = [
  "title",
  "href",
  "src",
  "alt",
  "name",
  "placeholder",
  "role",
  "rel",
  "target",
  "lang",
  "dir",
  "srcdoc",
];
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  times: "×",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
  larr: "←",
  rarr: "→",
};

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

export function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, name) => {
    if (name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function kebabToCamel(name) {
  return String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToKebab(name) {
  return String(name).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// ---------------------------------------------------------------- selectors

const selectorCache = new Map();

function parseCompound(src, selector) {
  const out = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let i = 0;
  const tag = src.match(/^(\*|[a-zA-Z][\w-]*)/);
  if (tag) {
    if (tag[1] !== "*") out.tag = tag[1].toLowerCase();
    i = tag[1].length;
  }
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^#([\w-]+)/))) {
      out.id = m[1];
    } else if ((m = rest.match(/^\.([\w-]+)/))) {
      out.classes.push(m[1]);
    } else if (
      (m = rest.match(
        /^\[\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/,
      ))
    ) {
      out.attrs.push({ name: m[1], op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? null });
    } else if ((m = rest.match(/^:not\(([^()]*)\)/))) {
      out.pseudos.push({ name: "not", arg: parseSelector(m[1]) });
    } else if ((m = rest.match(/^:(first-child|last-child|checked|disabled|scope)/))) {
      out.pseudos.push({ name: m[1] });
    } else {
      throw new Error(`fake DOM: unsupported selector ${JSON.stringify(selector)}`);
    }
    i += m[0].length;
  }
  return out;
}

function selectorTokens(src) {
  // Split on whitespace and ">" outside brackets, parens and quotes.
  const tokens = [];
  let cur = "";
  let depth = 0;
  let quote = null;
  for (const ch of src) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    if (depth === 0 && (/\s/.test(ch) || ch === ">")) {
      if (cur) tokens.push(cur);
      if (ch === ">") tokens.push(">");
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseComplex(src) {
  // [{ compound, combinator }] left-to-right; combinator links to the previous part
  const parts = [];
  const tokens = selectorTokens(src.trim());
  let combinator = " ";
  for (const token of tokens) {
    if (token === ">") {
      combinator = ">";
      continue;
    }
    parts.push({ compound: parseCompound(token, src), combinator });
    combinator = " ";
  }
  return parts;
}

function parseSelector(selector) {
  const key = String(selector ?? "");
  if (selectorCache.has(key)) return selectorCache.get(key);
  const groups = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < key.length; i++) {
    if (key[i] === "(" || key[i] === "[") depth += 1;
    else if (key[i] === ")" || key[i] === "]") depth -= 1;
    else if (key[i] === "," && depth === 0) {
      groups.push(key.slice(start, i));
      start = i + 1;
    }
  }
  groups.push(key.slice(start));
  const parsed = groups.map((g) => g.trim()).filter(Boolean).map(parseComplex);
  if (!parsed.length) throw new Error(`fake DOM: empty selector ${JSON.stringify(key)}`);
  selectorCache.set(key, parsed);
  return parsed;
}

function matchCompound(el, c, scope) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.localName.toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const got = el.getAttribute(a.name);
    if (got == null) return false;
    if (!a.op) continue;
    const want = a.value ?? "";
    if (a.op === "=" && got !== want) return false;
    if (a.op === "~=" && !got.split(/\s+/).includes(want)) return false;
    if (a.op === "^=" && !got.startsWith(want)) return false;
    if (a.op === "$=" && !got.endsWith(want)) return false;
    if (a.op === "*=" && !got.includes(want)) return false;
    if (a.op === "|=" && got !== want && !got.startsWith(`${want}-`)) return false;
  }
  for (const p of c.pseudos) {
    if (p.name === "not" && matchesParsed(el, p.arg, scope)) return false;
    if (p.name === "first-child" && el.parentNode?.children?.[0] !== el) return false;
    if (p.name === "last-child" && el.parentNode?.children?.at(-1) !== el) return false;
    if (p.name === "checked" && !el.checked && !el.selected) return false;
    if (p.name === "disabled" && !el.disabled) return false;
    if (p.name === "scope" && el !== scope) return false;
  }
  return true;
}

function matchComplex(el, parts, index, scope) {
  if (!matchCompound(el, parts[index].compound, scope)) return false;
  if (index === 0) return true;
  const { combinator } = parts[index];
  let node = el.parentNode;
  if (combinator === ">") return node ? matchComplex(node, parts, index - 1, scope) : false;
  while (node && node.nodeType === 1) {
    if (matchComplex(node, parts, index - 1, scope)) return true;
    node = node.parentNode;
  }
  return false;
}

function matchesParsed(el, groups, scope) {
  return groups.some((parts) => matchComplex(el, parts, parts.length - 1, scope));
}

export function matchesSelector(el, selector, scope = null) {
  return matchesParsed(el, parseSelector(selector), scope);
}

// ------------------------------------------------------------------- events

function setEventProp(event, key, value) {
  try {
    Object.defineProperty(event, key, { value, configurable: true, writable: true });
  } catch {
    // frozen event: ignore
  }
}

function normalizeEvent(event, target) {
  const ev = event && typeof event === "object" ? event : { type: String(event) };
  if (ev.target == null) setEventProp(ev, "target", target);
  if (typeof ev.preventDefault !== "function") {
    setEventProp(ev, "preventDefault", function preventDefault() {
      setEventProp(ev, "defaultPrevented", true);
    });
  }
  if (typeof ev.stopPropagation !== "function") {
    setEventProp(ev, "stopPropagation", function stopPropagation() {
      setEventProp(ev, "_stopped", true);
    });
  } else if (!ev._wrappedStop) {
    const original = ev.stopPropagation;
    setEventProp(ev, "stopPropagation", function stopPropagation(...args) {
      setEventProp(ev, "_stopped", true);
      return original.apply(this, args);
    });
    setEventProp(ev, "_wrappedStop", true);
  }
  if (typeof ev.stopImmediatePropagation !== "function") {
    setEventProp(ev, "stopImmediatePropagation", function stopImmediatePropagation() {
      setEventProp(ev, "_stopped", true);
      setEventProp(ev, "_stoppedNow", true);
    });
  }
  return ev;
}

class FakeEventTarget {
  constructor() {
    Object.defineProperty(this, "_listeners", { value: {}, writable: true });
  }

  addEventListener(type, fn, options) {
    if (typeof fn !== "function" && !(fn && typeof fn.handleEvent === "function")) return;
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const once = typeof options === "object" && !!options?.once;
    const list = (this._listeners[String(type)] ||= []);
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once });
  }

  removeEventListener(type, fn, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const list = this._listeners[String(type)];
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }

  _eventParent() {
    return this.parentNode ?? null;
  }

  _fire(ev, phase, results) {
    const list = this._listeners[String(ev.type)];
    if (!list) return;
    for (const entry of [...list]) {
      if (phase === "capture" && !entry.capture) continue;
      if (phase === "bubble" && entry.capture) continue;
      if (entry.once) this.removeEventListener(ev.type, entry.fn, entry.capture);
      setEventProp(ev, "currentTarget", this);
      const fn = typeof entry.fn === "function" ? entry.fn : entry.fn.handleEvent.bind(entry.fn);
      results.push(fn.call(this, ev));
      if (ev._stoppedNow) return;
    }
  }

  dispatchEvent(event) {
    const ev = normalizeEvent(event, this);
    const path = [];
    for (let node = this._eventParent(); node; node = node._eventParent?.() ?? null) {
      if (typeof node._fire === "function") path.push(node);
    }
    const results = [];
    for (let i = path.length - 1; i >= 0 && !ev._stopped; i--) {
      path[i]._fire(ev, "capture", results);
    }
    if (!ev._stopped) this._fire(ev, "target", results);
    if (ev.bubbles) {
      for (const node of path) {
        if (ev._stopped) break;
        node._fire(ev, "bubble", results);
      }
    }
    // Listener return values, so clickAndAwait() can await async handlers.
    Object.defineProperty(this, "_lastDispatch", {
      value: results,
      configurable: true,
      writable: true,
    });
    return !ev.defaultPrevented;
  }
}

// -------------------------------------------------------------------- nodes

class FakeText {
  constructor(data, ownerDocument = null) {
    this.nodeType = 3;
    this.nodeName = "#text";
    this.data = String(data ?? "");
    this.parentNode = null;
    this.ownerDocument = ownerDocument;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value ?? "");
  }

  get nodeValue() {
    return this.data;
  }

  get parentElement() {
    return this.parentNode;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  _eventParent() {
    return this.parentNode;
  }
}

function makeClassList(el) {
  const tokens = () =>
    String(el.getAttribute("class") || "")
      .split(/\s+/)
      .filter(Boolean);
  const write = (list) => el.setAttribute("class", [...new Set(list)].join(" "));
  return {
    add(...names) {
      write([...tokens(), ...names.map(String).filter(Boolean)]);
    },
    remove(...names) {
      const drop = new Set(names.map(String));
      write(tokens().filter((t) => !drop.has(t)));
    },
    toggle(name, force) {
      const n = String(name);
      const on = force === undefined ? !tokens().includes(n) : !!force;
      if (on) this.add(n);
      else this.remove(n);
      return on;
    },
    contains(name) {
      return tokens().includes(String(name));
    },
    replace(from, to) {
      if (!this.contains(from)) return false;
      write(tokens().map((t) => (t === from ? String(to) : t)));
      return true;
    },
    item(i) {
      return tokens()[i] ?? null;
    },
    forEach(fn) {
      tokens().forEach(fn);
    },
    get length() {
      return tokens().length;
    },
    get value() {
      return tokens().join(" ");
    },
    toString() {
      return tokens().join(" ");
    },
    [Symbol.iterator]() {
      return tokens()[Symbol.iterator]();
    },
  };
}

function makeDataset(el) {
  const attrName = (key) => `data-${camelToKebab(String(key))}`;
  const keys = () =>
    Object.keys(el.attributes)
      .filter((k) => k.startsWith("data-"))
      .map((k) => kebabToCamel(k.slice(5)));
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (typeof key === "symbol") return undefined;
        const v = el.attributes[attrName(key)];
        return v === undefined ? undefined : v;
      },
      set(_t, key, value) {
        if (typeof key === "symbol") return true;
        el.setAttribute(attrName(key), String(value));
        return true;
      },
      deleteProperty(_t, key) {
        if (typeof key !== "symbol") el.removeAttribute(attrName(key));
        return true;
      },
      has(_t, key) {
        return typeof key !== "symbol" && attrName(key) in el.attributes;
      },
      ownKeys() {
        return keys();
      },
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key === "symbol" || !(attrName(key) in el.attributes)) return undefined;
        return {
          value: el.attributes[attrName(key)],
          writable: true,
          enumerable: true,
          configurable: true,
        };
      },
    },
  );
}

function makeStyle() {
  const style = {};
  Object.defineProperties(style, {
    setProperty: {
      value(name, value) {
        style[String(name).startsWith("--") ? name : kebabToCamel(name)] = String(value ?? "");
      },
    },
    getPropertyValue: {
      value(name) {
        return style[String(name).startsWith("--") ? name : kebabToCamel(name)] ?? "";
      },
    },
    removeProperty: {
      value(name) {
        const key = String(name).startsWith("--") ? name : kebabToCamel(name);
        const prev = style[key] ?? "";
        delete style[key];
        return prev;
      },
    },
  });
  return style;
}

class FakeElement extends FakeEventTarget {
  constructor(tag, ownerDocument = null, namespaceURI = HTML_NS) {
    super();
    const raw = String(tag || "div");
    const html = namespaceURI === HTML_NS;
    this.nodeType = 1;
    this.namespaceURI = namespaceURI;
    this.localName = html ? raw.toLowerCase() : raw;
    this.tagName = html ? raw.toUpperCase() : raw;
    this.nodeName = this.tagName;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    // Plain object of attribute strings (the source of truth for attributes).
    this.attributes = {};
    this.style = makeStyle();
    this.dataset = makeDataset(this);
    this.classList = makeClassList(this);
  }

  // ---- tree
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }

  get childElementCount() {
    return this.children.length;
  }

  _sibling(step, elementsOnly) {
    const list = this.parentNode ? this.parentNode.childNodes : [];
    let i = list.indexOf(this) + step;
    while (i >= 0 && i < list.length) {
      if (!elementsOnly || list[i].nodeType === 1) return list[i];
      i += step;
    }
    return null;
  }

  get nextSibling() {
    return this._sibling(1, false);
  }

  get previousSibling() {
    return this._sibling(-1, false);
  }

  get nextElementSibling() {
    return this._sibling(1, true);
  }

  get previousElementSibling() {
    return this._sibling(-1, true);
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.nodeType === 9;
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  _adopt(node) {
    if (typeof node === "string") return [new FakeText(node, this.ownerDocument)];
    if (node && node.nodeType === 11) {
      const kids = [...node.childNodes];
      node.childNodes = [];
      for (const k of kids) k.parentNode = null;
      return kids;
    }
    if (node?.parentNode) node.parentNode.removeChild(node);
    return [node];
  }

  insertBefore(node, ref) {
    const nodes = this._adopt(node);
    const i = ref == null ? -1 : this.childNodes.indexOf(ref);
    const at = i < 0 ? this.childNodes.length : i;
    this.childNodes.splice(at, 0, ...nodes);
    for (const n of nodes) n.parentNode = this;
    return node;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }

  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) this.insertBefore(n, first);
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    if (node) node.parentNode = null;
    return node;
  }

  replaceChildren(...nodes) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  replaceChild(next, prev) {
    this.insertBefore(next, prev);
    return this.removeChild(prev);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  before(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    for (const n of nodes) parent.insertBefore(n, this);
  }

  after(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const next = this.nextSibling;
    for (const n of nodes) parent.insertBefore(n, next);
  }

  replaceWith(...nodes) {
    this.before(...nodes);
    this.remove();
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  // ---- attributes
  setAttribute(name, value) {
    const key = String(name);
    this.attributes[key] = String(value);
  }

  getAttribute(name) {
    const key = String(name);
    if (Object.prototype.hasOwnProperty.call(this.attributes, key)) return this.attributes[key];
    const lower = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(this.attributes, lower)) return this.attributes[lower];
    return null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) != null;
  }

  removeAttribute(name) {
    delete this.attributes[String(name)];
  }

  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : !!force;
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return on;
  }

  getAttributeNames() {
    return Object.keys(this.attributes);
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  get className() {
    return this.getAttribute("class") ?? "";
  }

  set className(value) {
    this.setAttribute("class", value);
  }

  get hidden() {
    return this.hasAttribute("hidden");
  }

  set hidden(value) {
    this.toggleAttribute("hidden", !!value);
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(value) {
    this.toggleAttribute("disabled", !!value);
  }

  get type() {
    const t = this.getAttribute("type");
    if (t != null) return t.toLowerCase();
    if (this.localName === "input") return "text";
    if (this.localName === "button") return "submit";
    return "";
  }

  set type(value) {
    this.setAttribute("type", value);
  }

  get tabIndex() {
    const n = Number(this.getAttribute("tabindex"));
    return Number.isFinite(n) && this.hasAttribute("tabindex") ? n : -1;
  }

  set tabIndex(value) {
    this.setAttribute("tabindex", value);
  }

  // ---- form state
  get checked() {
    return this._checked ?? this.hasAttribute("checked");
  }

  set checked(value) {
    this._checked = !!value;
  }

  get selected() {
    return this._selected ?? this.hasAttribute("selected");
  }

  set selected(value) {
    this._selected = !!value;
  }

  get options() {
    return this.querySelectorAll("option");
  }

  get selectedIndex() {
    const opts = this.options;
    const i = opts.findIndex((o) => o.selected);
    if (i >= 0) return i;
    return opts.length && !this._noSelection ? 0 : -1;
  }

  set selectedIndex(index) {
    this.options.forEach((o, i) => {
      o.selected = i === Number(index);
    });
    this._noSelection = !(Number(index) >= 0);
  }

  get value() {
    if (this.localName === "select") {
      const opt = this.options[this.selectedIndex];
      return opt ? opt.value : "";
    }
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    if (this.localName === "textarea") return this._value ?? this.textContent;
    if (this.localName === "input") return this._value ?? this.getAttribute("value") ?? "";
    if (this._value !== undefined) return this._value;
    return this.localName === "button" ? (this.getAttribute("value") ?? "") : undefined;
  }

  set value(value) {
    if (this.localName === "select") {
      const want = String(value ?? "");
      let found = false;
      for (const o of this.options) {
        o.selected = !found && o.value === want;
        if (o.selected) found = true;
      }
      this._noSelection = !found;
      return;
    }
    if (this.localName === "option") {
      this.setAttribute("value", value);
      return;
    }
    this._value = value == null ? "" : String(value);
  }

  // ---- text and markup
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }

  set textContent(value) {
    this.replaceChildren();
    const text = value == null ? "" : String(value);
    if (text) this.appendChild(new FakeText(text, this.ownerDocument));
  }

  get innerText() {
    return this.textContent;
  }

  set innerText(value) {
    this.textContent = value;
  }

  get innerHTML() {
    return this.childNodes.map(serialize).join("");
  }

  set innerHTML(value) {
    const html = value == null ? "" : String(value);
    if (RAW_TEXT_TAGS.has(this.localName)) {
      this.textContent = html;
      return;
    }
    this.replaceChildren(...parseHTML(html, this.ownerDocument, this.namespaceURI));
  }

  get outerHTML() {
    return serialize(this);
  }

  insertAdjacentHTML(position, html) {
    const nodes = parseHTML(String(html ?? ""), this.ownerDocument, this.namespaceURI);
    const where = String(position).toLowerCase();
    if (where === "beforebegin") this.before(...nodes);
    else if (where === "afterend") this.after(...nodes);
    else if (where === "afterbegin") this.prepend(...nodes);
    else this.append(...nodes);
  }

  insertAdjacentElement(position, node) {
    const where = String(position).toLowerCase();
    if (where === "beforebegin") this.before(node);
    else if (where === "afterend") this.after(node);
    else if (where === "afterbegin") this.prepend(node);
    else this.append(node);
    return node;
  }

  // ---- selectors
  matches(selector) {
    return matchesSelector(this, selector, this);
  }

  closest(selector) {
    const groups = parseSelector(selector);
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
      if (matchesParsed(n, groups, this)) return n;
    }
    return null;
  }

  querySelectorAll(selector) {
    const groups = parseSelector(selector);
    const out = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType !== 1) continue;
        if (matchesParsed(c, groups, this)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getElementsByTagName(tag) {
    return this.querySelectorAll(tag);
  }

  getElementsByClassName(name) {
    return this.querySelectorAll(
      String(name)
        .split(/\s+/)
        .filter(Boolean)
        .map((c) => `.${c}`)
        .join(""),
    );
  }

  // ---- interaction
  click() {
    if (this.disabled) return true;
    const toggles =
      this.localName === "input" && (this.type === "checkbox" || this.type === "radio");
    const before = this.checked;
    if (toggles) this.checked = this.type === "radio" ? true : !before;
    const ok = this.dispatchEvent({ type: "click", bubbles: true, cancelable: true, button: 0 });
    const results = this._lastDispatch;
    if (toggles && !ok) this.checked = before;
    if (toggles && ok && this.checked !== before) {
      this.dispatchEvent({ type: "input", bubbles: true });
      this.dispatchEvent({ type: "change", bubbles: true });
      this._lastDispatch = results;
    }
    return ok;
  }

  focus() {
    this._focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    this._focused = false;
    if (this.ownerDocument?.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  scrollIntoView() {}
}

for (const name of REFLECTED) {
  Object.defineProperty(FakeElement.prototype, name, {
    get() {
      return this.getAttribute(name) ?? "";
    },
    set(value) {
      this.setAttribute(name, value);
    },
    configurable: true,
  });
}

class FakeFragment extends FakeElement {
  constructor(ownerDocument) {
    super("#document-fragment", ownerDocument);
    this.nodeType = 11;
    this.nodeName = "#document-fragment";
  }
}

function serialize(node) {
  if (node.nodeType === 3) {
    const parent = node.parentNode?.localName;
    return parent === "script" || parent === "style" ? node.data : escapeText(node.data);
  }
  if (node.nodeType === 11) return node.childNodes.map(serialize).join("");
  const attrs = Object.entries(node.attributes)
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
    .join("");
  const tag = node.localName;
  if (node.namespaceURI === HTML_NS && VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${node.childNodes.map(serialize).join("")}</${tag}>`;
}

// ------------------------------------------------------------------- parser

function readAttributes(html, start) {
  // Returns { attrs, end, selfClosing } where end is the index after ">".
  const attrs = [];
  let i = start;
  const n = html.length;
  while (i < n) {
    while (i < n && /\s/.test(html[i])) i++;
    if (html[i] === ">") return { attrs, end: i + 1, selfClosing: false };
    if (html[i] === "/" && html[i + 1] === ">") return { attrs, end: i + 2, selfClosing: true };
    if (html[i] === "/") {
      i++;
      continue;
    }
    let name = "";
    while (i < n && !/[\s=>]/.test(html[i]) && !(html[i] === "/" && html[i + 1] === ">")) {
      name += html[i++];
    }
    while (i < n && /\s/.test(html[i])) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        const stop = close < 0 ? n : close;
        value = html.slice(i + 1, stop);
        i = stop + 1;
      } else {
        while (i < n && !/[\s>]/.test(html[i])) value += html[i++];
      }
    }
    if (name) attrs.push([name, decodeEntities(value)]);
  }
  return { attrs, end: n, selfClosing: false };
}

export function parseHTML(html, ownerDocument = null, namespaceURI = HTML_NS) {
  const root = new FakeFragment(ownerDocument);
  root.namespaceURI = namespaceURI;
  const stack = [root];
  const src = String(html ?? "");
  let i = 0;
  const top = () => stack[stack.length - 1];
  const text = (data) => {
    if (data) top().appendChild(new FakeText(decodeEntities(data), ownerDocument));
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      text(src.slice(i));
      break;
    }
    text(src.slice(i, lt));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[i + 1] === "!" || src[i + 1] === "?") {
      const end = src.indexOf(">", i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const close = src.slice(i).match(/^<\/([a-zA-Z][\w:-]*)\s*>/);
    if (close) {
      const want = close[1].toLowerCase();
      const at = stack.findLastIndex((n, k) => k > 0 && n.localName.toLowerCase() === want);
      if (at > 0) stack.length = at;
      i += close[0].length;
      continue;
    }
    const open = src.slice(i).match(/^<([a-zA-Z][\w:-]*)/);
    if (!open) {
      text("<");
      i += 1;
      continue;
    }
    const tag = open[1];
    const { attrs, end, selfClosing } = readAttributes(src, i + open[0].length);
    const parentNs = top().namespaceURI;
    const ns = tag.toLowerCase() === "svg" ? SVG_NS : parentNs === SVG_NS ? SVG_NS : HTML_NS;
    const el = new FakeElement(ns === HTML_NS ? tag.toLowerCase() : tag, ownerDocument, ns);
    for (const [k, v] of attrs) el.setAttribute(ns === HTML_NS ? k.toLowerCase() : k, v);
    top().appendChild(el);
    i = end;
    const lower = tag.toLowerCase();
    if (selfClosing || (ns === HTML_NS && VOID_TAGS.has(lower))) continue;
    if (ns === HTML_NS && RAW_TEXT_TAGS.has(lower)) {
      const closeRe = new RegExp(`</${lower}\\s*>`, "i");
      const rest = src.slice(i);
      const m = rest.match(closeRe);
      const body = m ? rest.slice(0, m.index) : rest;
      const data = lower === "script" || lower === "style" ? body : decodeEntities(body);
      if (data) el.appendChild(new FakeText(data, ownerDocument));
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }
    stack.push(el);
  }
  const nodes = [...root.childNodes];
  root.childNodes = [];
  for (const n of nodes) n.parentNode = null;
  return nodes;
}

// ----------------------------------------------------------------- document

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.nodeType = 9;
    this.nodeName = "#document";
    this.childNodes = [];
    this.defaultView = null;
    this.readyState = "complete";
    this.activeElement = null;
  }

  get documentElement() {
    return this.childNodes.find((n) => n.nodeType === 1) ?? null;
  }

  get head() {
    return this.documentElement?.children.find((c) => c.localName === "head") ?? null;
  }

  get body() {
    return this.documentElement?.children.find((c) => c.localName === "body") ?? null;
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  _eventParent() {
    return this.defaultView;
  }

  appendChild(node) {
    node.parentNode?.removeChild?.(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  getElementById(id) {
    const want = String(id);
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c.getAttribute("id") === want) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }

  querySelectorAll(selector) {
    const html = this.documentElement;
    if (!html) return [];
    const groups = parseSelector(selector);
    const self = matchesParsed(html, groups, null) ? [html] : [];
    return [...self, ...html.querySelectorAll(selector)];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getElementsByTagName(tag) {
    return this.querySelectorAll(tag);
  }

  getElementsByClassName(name) {
    return this.documentElement?.getElementsByClassName(name) ?? [];
  }

  createElement(tag) {
    return new FakeElement(String(tag), this, HTML_NS);
  }

  createElementNS(ns, tag) {
    return new FakeElement(String(tag), this, ns || HTML_NS);
  }

  createTextNode(data) {
    return new FakeText(data, this);
  }

  createDocumentFragment() {
    return new FakeFragment(this);
  }
}

function adoptTree(node, doc) {
  node.ownerDocument = doc;
  for (const c of node.childNodes || []) adoptTree(c, doc);
}

// Parse a whole HTML document (default: src/index.html) into a FakeDocument.
export function createDocument(html = loadHtml()) {
  const doc = new FakeDocument();
  const nodes = parseHTML(html, doc);
  let root = nodes.find((n) => n.nodeType === 1 && n.localName === "html");
  if (!root) {
    root = doc.createElement("html");
    const body = doc.createElement("body");
    body.append(...nodes);
    root.append(doc.createElement("head"), body);
  }
  adoptTree(root, doc);
  doc.appendChild(root);
  doc.activeElement = doc.body;
  return doc;
}

// A window-like event target for a FakeDocument; events bubble document -> window.
export function createWindow(doc = createDocument(), { storage = memoryStorage() } = {}) {
  const win = new FakeEventTarget();
  win.document = doc;
  win.localStorage = storage;
  win.innerWidth = 800;
  win.innerHeight = 600;
  doc.defaultView = win;
  return win;
}

// A detached element for unit tests that build their own tiny documents.
// Kept loose defaults (select value "name", inputs checked) so the older
// module-level tests that rely on them keep their meaning.
export function mockEl(id = "", tag = "div") {
  const el = new FakeElement(String(tag), null, HTML_NS);
  if (id) el.id = String(id);
  if (tag === "select") Object.defineProperty(el, "value", { value: "name", writable: true });
  if (tag === "input") {
    el.checked = true;
    if (!el.hasAttribute("type")) el.type = "checkbox";
  }
  if (tag === "button" && !el.hasAttribute("type")) el.type = "button";
  if (id === "dirty" || id === "html-viewer" || id === "html-js-warn") el.hidden = true;
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

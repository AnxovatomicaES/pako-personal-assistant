// A small stand-in for the browser's document, enough to run a panel script (src/panel/*.js) in a test: elements that keep their children,
// attributes and listeners, a few selectors (#id, .class, tag, [attr], and a descendant chain of them), and timers that only run when the
// test says so. It checks what a script does to the page, not how a browser draws it. Nothing here touches the network or the clock.

type Listener = (event: Record<string, unknown>) => unknown;

export class FakeNode {
  parent: FakeElement | null = null;
  get textContent(): string {
    return "";
  }
}

export class FakeText extends FakeNode {
  data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
}

const words = (v: string): string[] => v.split(/\s+/).filter(Boolean);

/** One simple selector: tag#id.class[attr] in any mix; `*` matches all. */
function matchesSimple(el: FakeElement, sel: string): boolean {
  const re = /(^[a-z][a-z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/gi;
  let rest = sel;
  for (const m of sel.matchAll(re)) {
    rest = rest.replace(m[0], "");
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.id !== m[2]) return false;
    if (m[3] && !words(el.className).includes(m[3])) return false;
    if (m[4]) {
      const v = el.getAttribute(m[4]);
      if (v === null || (m[5] !== undefined && v !== m[5])) return false;
    }
  }
  return rest.replace("*", "") === "";
}

export class FakeElement extends FakeNode {
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  className = "";
  hidden = false;
  value = "";
  checked = false;
  open = false;
  dataset: Record<string, string> = {};
  focused = false;
  tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }
  get id(): string {
    return this.attrs.get("id") ?? "";
  }
  get classList() {
    const el = this;
    return {
      add: (...c: string[]) => void (el.className = [...new Set([...words(el.className), ...c])].join(" ")),
      remove: (...c: string[]) => void (el.className = words(el.className).filter((x) => !c.includes(x)).join(" ")),
      contains: (c: string) => words(el.className).includes(c),
      toggle: (c: string, on?: boolean) => {
        const has = words(el.className).includes(c);
        const want = on ?? !has;
        if (want && !has) el.classList.add(c);
        if (!want && has) el.classList.remove(c);
        return want;
      },
    };
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
    if (k === "class") this.className = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  /** As the DOM takes them: a node is moved here, anything else becomes its text (a null is the word "null"). */
  private adopt(nodes: unknown[]): FakeNode[] {
    return nodes.map((n) => {
      const node = n instanceof FakeNode ? n : new FakeText(String(n));
      node.parent?.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      return node;
    });
  }
  append(...nodes: unknown[]): void {
    this.children.push(...this.adopt(nodes));
  }
  prepend(...nodes: unknown[]): void {
    this.children.unshift(...this.adopt(nodes));
  }
  replaceChildren(...nodes: unknown[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(node: FakeNode): void {
    const p = this.parent;
    if (!p) return;
    const at = p.children.indexOf(this);
    this.parent = null;
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = p;
    p.children.splice(at, 1, node);
  }
  contains(node: FakeNode | null): boolean {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  get childElementCount(): number {
    return this.children.filter((c) => c instanceof FakeElement).length;
  }
  override get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  override set textContent(v: string) {
    this.replaceChildren(String(v));
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** What a user does: listeners run in order, an async one's promise is returned so the test can wait for it. */
  async fire(type: string, event: Record<string, unknown> = {}): Promise<void> {
    const e = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners.get(type) ?? []) await fn(e);
  }
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [c, ...c.descendants()] : []));
  }
  querySelectorAll(selector: string): FakeElement[] {
    const chain = selector.trim().split(/\s+/);
    return this.descendants().filter((el) => {
      if (!matchesSimple(el, chain[chain.length - 1]!)) return false;
      let up: FakeElement | null = el.parent;
      for (let i = chain.length - 2; i >= 0; i--) {
        while (up && !matchesSimple(up, chain[i]!)) up = up.parent;
        if (!up) return false;
        up = up.parent;
      }
      return true;
    });
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  focus(): void {
    this.focused = true;
  }
  setSelectionRange(): void {}
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
}

/**
 * Timers a test runs by hand: nothing fires by itself, so nothing waits on the clock. `install(set)` puts them in the globals for every delay
 * of `from` ms or more (a page's refresh, its toast); shorter ones stay real, so the test's own waits (test/helpers/wait.ts) still work.
 */
export function fakeTimers(from = 1000) {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const add = (fn: () => void, ms = 0): number => {
    pending.set(next, { fn, ms });
    return next++;
  };
  return {
    install: (set: (name: string, value: unknown) => void): void => {
      set("setTimeout", (fn: () => void, ms = 0, ...args: unknown[]) => (ms >= from ? add(fn, ms) : real.setTimeout(fn, ms, ...args)));
      set("clearTimeout", (id: unknown) => (typeof id === "number" ? void pending.delete(id) : real.clearTimeout(id as never)));
    },
    /** The delays of what is waiting. */
    get waiting(): number[] {
      return [...pending.values()].map((t) => t.ms);
    },
    /** Runs what waits (the newest first) and takes it off. */
    fireLast(): boolean {
      const id = [...pending.keys()].at(-1);
      if (id === undefined) return false;
      const t = pending.get(id)!;
      pending.delete(id);
      t.fn();
      return true;
    },
    clear: () => pending.clear(),
  };
}

type Globals = Record<string, unknown>;

/**
 * Puts a document (and Node, for `instanceof Node`) in the globals a panel script reads, and the page's `ids` in its body, as the HTML
 * has them. `restore` puts the globals back. Pass the other globals the script needs (fetch, localStorage...) with `set`.
 */
export function installDom(ids: Record<string, string> = {}) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown): void => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  const body = new FakeElement("body");
  const root = new FakeElement("html");
  root.append(body);
  const doc = {
    body,
    documentElement: root,
    readyState: "complete",
    visibilityState: "visible",
    hidden: false,
    listeners: new Map<string, Listener[]>(),
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (s: string) => new FakeText(String(s)),
    getElementById: (id: string) => root.querySelector(`#${id}`),
    querySelector: (s: string) => root.querySelector(s),
    querySelectorAll: (s: string) => root.querySelectorAll(s),
    addEventListener(type: string, fn: Listener) {
      doc.listeners.set(type, [...(doc.listeners.get(type) ?? []), fn]);
    },
    removeEventListener() {},
    /** The page comes back into view (or goes away): its listeners run. */
    async fire(type: string) {
      for (const fn of doc.listeners.get(type) ?? []) await fn({ type });
    },
  };
  set("document", doc);
  set("Node", FakeNode);
  for (const [id, tag] of Object.entries(ids)) {
    const el = new FakeElement(tag);
    el.setAttribute("id", id);
    body.append(el);
  }
  return {
    doc,
    set,
    el: (id: string): FakeElement => {
      const e = doc.getElementById(id);
      if (!e) throw new Error(`no #${id} on the page`);
      return e;
    },
    restore: (): void => {
      for (const [name, d] of saved) {
        if (d) Object.defineProperty(globalThis, name, d);
        else delete (globalThis as Globals)[name];
      }
    },
  };
}

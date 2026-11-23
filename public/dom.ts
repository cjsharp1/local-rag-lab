/**
 * dom.ts — the two helpers every other browser file builds the page with.
 *
 * el() makes an element from a tag, attributes and children. Text always
 * goes in as a text node (textContent), never as HTML: the page renders
 * corpus text, model answers and log details, and none of that may ever
 * be parsed as markup (PLAN §10). There is no innerHTML anywhere in
 * public/, and this helper is why none is needed.
 *
 * $() finds an element by id and fails loudly if it's missing, so a typo
 * in an id is an error on load rather than a silent dead button.
 */

type Child = Node | string | number | null | undefined | false;

/** Creates an element. Strings and numbers become text nodes; falsy children are skipped. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name === "class") node.className = String(value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

/** Appends children like el() does: text as text nodes, falsy children skipped. */
export function append(parent: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

/** The element with this id, typed; throws if it's not on the page. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`No element with id "${id}"`);
  return node as T;
}

/** Removes every child of an element. */
export function clear(node: Element): void {
  node.replaceChildren();
}

/** 1234 → "1,234". */
export function n(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

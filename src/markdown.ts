import { App, Component, MarkdownRenderer } from "obsidian";
import { MorphHandle, Spec } from "./morph";
import { paintOuterStyle } from "./outer-style";

export function unwrapRenderedMarkdown(el: HTMLElement) {
  while (el.children.length === 1 && el.firstElementChild?.tagName === "P") {
    const p = el.firstElementChild;
    el.replaceChildren(...Array.from(p.childNodes));
  }
  for (const p of Array.from(el.querySelectorAll("p"))) {
    if (p.parentElement !== el) continue;
    p.replaceWith(...Array.from(p.childNodes));
  }
}

export function peelOuterMarkup(before: string, after: string): { open: string; close: string } {
  let left = before.replace(/\s+$/, "");
  let right = after.replace(/^\s+/, "");
  let open = "";
  let close = "";
  let again = true;
  while (again) {
    again = false;
    const alias = left.match(/\[\[([^\]\n|]+)\|$/);
    if (alias && right.startsWith("]]")) {
      open = alias[0] + open;
      close += "]]";
      left = left.slice(0, -alias[0].length);
      right = right.slice(2);
      again = true;
      continue;
    }
    if (left.endsWith("[[") && right.startsWith("]]")) {
      open = "[[" + open;
      close += "]]";
      left = left.slice(0, -2);
      right = right.slice(2);
      again = true;
      continue;
    }
    const mdLink = right.match(/^\]\([^)]*\)/);
    if (left.endsWith("[") && !left.endsWith("[[") && mdLink) {
      open = "[" + open;
      close += mdLink[0];
      left = left.slice(0, -1);
      right = right.slice(mdLink[0].length);
      again = true;
    }
  }
  return { open, close };
}

export function applyOuterMarkup(spec: Spec, open: string, close: string): Spec {
  if (!open && !close) return spec;
  return {
    ...spec,
    items: spec.items.map((it) => ({ ...it, text: `${open}${it.text}${close}` })),
  };
}

export async function hydrateMorphMarkdown(
  handle: MorphHandle,
  spec: Spec,
  app: App,
  sourcePath: string,
  owner: Component
) {
  for (let i = 0; i < spec.items.length; i++) {
    const span = handle.itemEls[i];
    if (!span) continue;
    span.empty();
    const raw = spec.items[i].text;
    if (!raw) {
      span.textContent = "\u00a0";
      paintOuterStyle(span, spec.outerStyle ?? []);
      continue;
    }
    await MarkdownRenderer.render(app, raw, span, sourcePath, owner);
    unwrapRenderedMarkdown(span);
    paintOuterStyle(span, spec.outerStyle ?? []);
    for (const a of Array.from(span.querySelectorAll("a"))) {
      a.addEventListener("click", (e) => {
        e.stopPropagation();
        const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
        if (!href) return;
        if (a.classList.contains("external-link") || /^https?:/i.test(href)) return;
        e.preventDefault();
        const mouse = e as MouseEvent;
        void app.workspace.openLinkText(href, sourcePath, mouse.metaKey || mouse.ctrlKey);
      });
    }
  }
  handle.captureContent();
  handle.refresh();
}

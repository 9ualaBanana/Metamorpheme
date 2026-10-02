import {
  elementWindow,
  requestElementFrame,
  requestElementTimeout,
  watchElementVisibility,
  whenAttached,
} from "./animation-clock";
import type { OuterStyle } from "./outer-style";

export const STYLES = ["zoom", "blur", "slide", "crossfade", "diffuse"] as const;
export type Style = (typeof STYLES)[number];
export const ALIGNS = ["center", "justify", "left", "right"] as const;
export type Align = (typeof ALIGNS)[number];
export const ALIGN_LABELS: Record<Align, string> = {
  center: "Center",
  justify: "Justify",
  left: "Left",
  right: "Right",
};

export const STYLE_LABELS: Record<Style, string> = {
  zoom: "Zoom",
  blur: "Blur focus",
  crossfade: "Crossfade",
  slide: "Slide up",
  diffuse: "Diffuse",
};

export interface Defaults {
  /** seconds a word stays fully visible before the next one starts fading in */
  hold: number;
  /** seconds the transition into the next word takes */
  fade: number;
  style: Style;
  align: Align;
  separator: string;
}

export interface Item {
  text: string;
  hold?: number;
  fade?: number;
}

export interface Spec {
  items: Item[];
  hold?: number;
  fade?: number;
  style?: Style;
  align?: Align;
  outerStyle?: OuterStyle[];
}

export interface MorphHandle {
  el: HTMLElement;
  itemEls: HTMLElement[];
  destroy: () => void;
  captureContent: () => void;
  refresh: () => void;
  syncVisibility: () => void;
  play: () => void;
}

export const FILTER_ID = "obsidian-morph-threshold";

const OPTS = /^\s*(?:[a-z]+\s*=\s*[\w.]+\s*)+$/i;
const ITEM = /^(.*?)\s+@\s*(\d*\.?\d+)?(?:\s*\/\s*(\d*\.?\d+))?\s*$/;

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return isFinite(n) ? n : undefined;
}

/**
 * Parses the inside of `{~ ... ~}`:
 *   [hold=2 fade=1 style=slide align=left |] word [@hold[/fade]] | word [@hold[/fade]] | ...
 */
export function parseSpec(raw: string, separator: string): Spec {
  const parts = raw.split(separator).map((p) => p.replace(/\\\s*$/, "").trim());
  const spec: Spec = { items: [] };

  if (parts.length && OPTS.test(parts[0])) {
    const opts = parts.shift() as string;
    for (const m of opts.matchAll(/([a-z]+)\s*=\s*([\w.]+)/gi)) {
      const key = m[1].toLowerCase();
      const val = m[2].toLowerCase();
      if (key === "hold") spec.hold = num(m[2]);
      else if (key === "fade") spec.fade = num(m[2]);
      else if (key === "style") {
        const style = val === "morph" ? "diffuse" : val;
        if ((STYLES as readonly string[]).includes(style)) spec.style = style as Style;
      }
      else if (key === "align" && (ALIGNS as readonly string[]).includes(val)) spec.align = val as Align;
    }
  }

  for (const p of parts) {
    if (!p) {
      spec.items.push({ text: "" });
      continue;
    }
    const m = ITEM.exec(p);
    if (m && (m[2] !== undefined || m[3] !== undefined)) {
      spec.items.push({ text: m[1].trim(), hold: num(m[2]), fade: num(m[3]) });
    } else {
      spec.items.push({ text: p });
    }
  }
  if (spec.items.length && spec.items.every((it) => !it.text)) spec.items = [];
  return spec;
}

export function rewriteMorphSeparators(text: string, oldSep: string, newSep: string): string {
  if (!oldSep || oldSep === newSep) return text;
  return text.replace(/\{~(.+?)~\}/g, (full, inner: string) => {
    if (!inner.includes(oldSep)) return full;
    return `{~${inner.split(oldSep).join(newSep)}~}`;
  });
}

function reducedMotion(view: Window): boolean {
  return view.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** f = how visible the word is (0..1); incoming = true for the word appearing. */
function apply(style: Style, span: HTMLElement, f: number, incoming: boolean) {
  const s = span.style;
  const hasLink = !!span.querySelector("a");
  s.filter = "none";
  s.transform = "none";
  s.pointerEvents = f > 0.35 ? "auto" : "none";
  if (f <= 0.001) {
    s.opacity = "0";
    return;
  }
  if (hasLink) {
    s.opacity = String(style === "diffuse" ? Math.pow(f, 0.4) : f);
    return;
  }
  switch (style) {
    case "diffuse": {
      const blur = Math.min(8 / f - 8, 100);
      const extra = blur > 0.01 ? blur : 0.6;
      s.filter = `url(#${FILTER_ID}) blur(${extra}px)`;
      s.opacity = String(Math.pow(f, 0.4));
      break;
    }
    case "blur": {
      const blur = (1 - f) * 12;
      if (blur > 0.05) s.filter = `blur(${blur}px)`;
      s.opacity = String(f);
      break;
    }
    case "slide": {
      const dy = (1 - f) * 0.7 * (incoming ? 1 : -1);
      s.transform = `translateY(${dy}em)`;
      s.opacity = String(f);
      break;
    }
    case "zoom": {
      const sc = incoming ? 0.8 + 0.2 * f : 1 + 0.2 * (1 - f);
      s.transform = `scale(${sc})`;
      s.opacity = String(f);
      break;
    }
    default:
      s.opacity = String(f);
  }
}

export function createMorph(spec: Spec, d: Defaults): MorphHandle {
  const el = createSpan({ cls: "morph-text" });
  el.setAttr("aria-label", spec.items.map((i) => i.text).join(", "));
  const alignOf = (): Align => spec.align ?? d.align ?? "center";
  const justifyOf = (a: Align) =>
    a === "left" ? "start" : a === "right" ? "end" : a === "justify" ? "stretch" : "center";
  const place = () =>
    el.setCssProps({ "--morph-justify": justifyOf(alignOf() === "justify" ? "center" : alignOf()) });
  place();
  el.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !("instanceOf" in t) || !(t as Node).instanceOf(Element) || (t as Element).closest("a")) return;
    const a = (t as Element).closest(".morph-word")?.querySelector("a");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    a.click();
  });

  const spans = spec.items.map((it) => {
    const s = el.createSpan({ cls: "morph-word", attr: { "aria-hidden": "true" } });
    s.setText(it.text || "\u00a0");
    return s;
  });

  const n = spans.length;
  const style = (): Style => (reducedMotion(elementWindow(el)) ? "crossfade" : spec.style ?? d.style ?? "diffuse");
  const holdMs = (k: number) => Math.max(0, spec.items[k].hold ?? spec.hold ?? d.hold) * 1000;
  const fadeMs = (k: number) => Math.max(0.05, spec.items[k].fade ?? spec.fade ?? d.fade) * 1000;

  let i = 0;
  let fading = false;
  let running = false;
  let dead = false;
  let cancelHold = () => {};
  let cancelFrame = () => {};
  let htmlSnap: Node[][] | null = null;

  const captureContent = () => {
    htmlSnap = spans.map((s) => Array.from(s.childNodes).map((n) => n.cloneNode(true)));
  };

  const restore = (s: HTMLElement, idx: number) => {
    if (htmlSnap) {
      s.replaceChildren(...htmlSnap[idx].map((n) => n.cloneNode(true)));
      return;
    }
    const text = spec.items[idx].text;
    if (!text) {
      if (s.textContent !== "\u00a0") s.textContent = "\u00a0";
      return;
    }
    if (s.textContent !== text) s.textContent = text;
  };

  const glyphCount = (node: Node): number => {
    if (node.nodeType === Node.TEXT_NODE) {
      return Array.from(node.textContent ?? "").filter((c) => c !== " " && c !== "\u00a0" && c !== "\n").length;
    }
    let n = 0;
    node.childNodes.forEach((c) => {
      n += glyphCount(c);
    });
    return n;
  };

  const letterSpacing = (s: HTMLElement, value: string) => {
    s.setCssStyles({ letterSpacing: value });
  };

  const naturalWidth = (s: HTMLElement) => {
    const prev = s.style.letterSpacing;
    letterSpacing(s, "0");
    const w = s.scrollWidth;
    letterSpacing(s, prev);
    return w;
  };

  const fit = () => {
    if (dead) return;
    if (alignOf() !== "justify") {
      for (const s of spans) letterSpacing(s, "");
      return;
    }
    if (!el.isConnected) return;
    const wide = Math.max(...spans.map(naturalWidth), 0);
    if (wide <= 0) return;
    for (const s of spans) {
      const w = naturalWidth(s);
      const gaps = Math.max(0, glyphCount(s) - 1);
      letterSpacing(s, gaps && w + 0.5 < wide ? `${(wide - w) / gaps}px` : "0");
    }
  };

  const fitOnceAttached = whenAttached(el, fit);

  const show = (k: number) => {
    const st = style();
    el.dataset.style = st;
    place();
    spans.forEach((s, idx) => {
      apply(st, s, idx === k ? 1 : 0, true);
      restore(s, idx);
    });
    fitOnceAttached.schedule();
  };

  const scheduleHold = (seed = false) => {
    cancelHold();
    cancelHold = requestElementTimeout(el, holdMs(i) * (seed ? Math.random() : 1), beginFade);
  };

  const beginFade = () => {
    if (dead || !running) return;
    fading = true;
    const from = i;
    const to = (i + 1) % n;
    const dur = fadeMs(from);
    const st = style();
    el.dataset.style = st;
    const t0 = elementWindow(el).performance.now();
    const step = (now: number) => {
      if (dead || !running) return;
      const f = Math.min(1, (now - t0) / dur);
      const e = st === "diffuse" ? f : f * f * (3 - 2 * f);
      apply(st, spans[from], 1 - e, false);
      apply(st, spans[to], e, true);
      if (f < 1) {
        cancelFrame = requestElementFrame(el, step);
      } else {
        i = to;
        fading = false;
        show(i);
        scheduleHold();
      }
    };
    cancelFrame = requestElementFrame(el, step);
  };

  const play = () => {
    if (dead || running) return;
    running = true;
    scheduleHold(true);
  };

  const pause = () => {
    running = false;
    cancelHold();
    cancelFrame();
    if (fading) {
      i = (i + 1) % n;
      fading = false;
      show(i);
    }
  };

  show(0);

  let stopWatch = () => {};
  const playWhenVisible = whenAttached(el, () => {
    if (dead || n < 2) return;
    stopWatch();
    stopWatch = watchElementVisibility(el, (visible) => {
      if (dead) return;
      if (visible) play();
      else pause();
    });
  });
  if (n > 1) playWhenVisible.schedule();

  return {
    el,
    itemEls: spans,
    destroy: () => {
      dead = true;
      pause();
      fitOnceAttached.cancel();
      playWhenVisible.cancel();
      stopWatch();
    },
    captureContent,
    refresh: () => {
      show(i);
      if (n > 1) playWhenVisible.schedule();
    },
    syncVisibility: () => {
      if (dead || running || n < 2) return;
      playWhenVisible.schedule();
    },
    play,
  };
}

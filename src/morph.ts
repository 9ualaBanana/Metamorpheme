export const STYLES = ["morph", "crossfade", "blur", "slide", "zoom", "scramble"] as const;
export type Style = (typeof STYLES)[number];
export const ALIGNS = ["left", "center", "right", "justify"] as const;
export type Align = (typeof ALIGNS)[number];
export const ALIGN_LABELS: Record<Align, string> = {
  left: "Left",
  center: "Center",
  right: "Right",
  justify: "Justify",
};

export const STYLE_LABELS: Record<Style, string> = {
  morph: "Liquid morph",
  crossfade: "Crossfade",
  blur: "Blur focus",
  slide: "Slide up",
  zoom: "Zoom",
  scramble: "Scramble",
};

export interface Defaults {
  /** seconds a word stays fully visible before the next one starts fading in */
  hold: number;
  /** seconds the transition into the next word takes */
  fade: number;
  style: Style;
  align: Align;
  separator: string;
  keepEmpty: boolean;
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
}

export interface MorphHandle {
  el: HTMLElement;
  itemEls: HTMLElement[];
  destroy: () => void;
  captureContent: () => void;
  refresh: () => void;
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
export function parseSpec(raw: string, separator: string, keepEmpty = true): Spec {
  const parts = raw.split(separator).map((p) => p.replace(/\\\s*$/, "").trim());
  const spec: Spec = { items: [] };

  if (parts.length && OPTS.test(parts[0])) {
    const opts = parts.shift() as string;
    for (const m of opts.matchAll(/([a-z]+)\s*=\s*([\w.]+)/gi)) {
      const key = m[1].toLowerCase();
      const val = m[2].toLowerCase();
      if (key === "hold") spec.hold = num(m[2]);
      else if (key === "fade") spec.fade = num(m[2]);
      else if (key === "style" && (STYLES as readonly string[]).includes(val)) spec.style = val as Style;
      else if (key === "align" && (ALIGNS as readonly string[]).includes(val)) spec.align = val as Align;
    }
  }

  for (const p of parts) {
    if (!p) {
      if (keepEmpty) spec.items.push({ text: "" });
      continue;
    }
    const m = ITEM.exec(p);
    if (m && (m[2] !== undefined || m[3] !== undefined)) {
      spec.items.push({ text: m[1].trim(), hold: num(m[2]), fade: num(m[3]) });
    } else {
      spec.items.push({ text: p });
    }
  }
  if (keepEmpty && spec.items.length && spec.items.every((it) => !it.text)) spec.items = [];
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
    s.opacity = String(style === "morph" ? Math.pow(f, 0.4) : f);
    return;
  }
  switch (style) {
    case "morph": {
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
    case "scramble":
      // outgoing word vanishes in the first half; incoming is drawn by scramble()
      s.opacity = incoming ? "1" : String(Math.max(0, (f - 0.5) * 2));
      break;
    default:
      s.opacity = String(f);
  }
}

const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=?";

function scramble(text: string, f: number): string {
  const chars = Array.from(text);
  const done = Math.floor(f * chars.length);
  return chars
    .map((c, k) => (k < done || /\s/.test(c) ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
    .join("");
}

export function createMorph(spec: Spec, d: Defaults): MorphHandle {
  const el = document.createElement("span");
  el.className = "morph-text";
  el.setAttribute("aria-label", spec.items.map((i) => i.text).join(", "));
  const alignOf = (): Align => spec.align ?? d.align ?? "center";
  const justifyOf = (a: Align) =>
    a === "left" ? "start" : a === "right" ? "end" : a === "justify" ? "stretch" : "center";
  el.style.setProperty("--morph-justify", justifyOf(alignOf() === "justify" ? "center" : alignOf()));
  el.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element) || t.closest("a")) return;
    const a = t.closest(".morph-word")?.querySelector("a");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    a.click();
  });

  const spans = spec.items.map((it) => {
    const s = document.createElement("span");
    s.className = "morph-word";
    s.setAttribute("aria-hidden", "true");
    s.textContent = it.text || "\u00a0";
    el.appendChild(s);
    return s;
  });

  const n = spans.length;
  const host = () => el.ownerDocument.defaultView ?? window;
  const style = (): Style => (reducedMotion(host()) ? "crossfade" : spec.style ?? d.style ?? "morph");
  const holdMs = (k: number) => Math.max(0, spec.items[k].hold ?? spec.hold ?? d.hold) * 1000;
  const fadeMs = (k: number) => Math.max(0.05, spec.items[k].fade ?? spec.fade ?? d.fade) * 1000;

  let i = 0;
  let fading = false;
  let running = false;
  let dead = false;
  let timer = 0;
  let raf = 0;
  let clock: Window = window;
  let htmlSnap: string[] | null = null;

  const captureContent = () => {
    htmlSnap = spans.map((s) => s.innerHTML);
  };

  const restore = (s: HTMLElement, idx: number) => {
    if (htmlSnap) {
      if (s.innerHTML !== htmlSnap[idx]) s.innerHTML = htmlSnap[idx];
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

  const naturalWidth = (s: HTMLElement) => {
    const prev = s.style.letterSpacing;
    s.style.letterSpacing = "0";
    const w = s.scrollWidth;
    s.style.letterSpacing = prev;
    return w;
  };

  const fit = () => {
    if (alignOf() !== "justify") {
      for (const s of spans) s.style.letterSpacing = "";
      return;
    }
    if (!el.isConnected) {
      queueMicrotask(() => {
        if (!dead) fit();
      });
      return;
    }
    const wide = Math.max(...spans.map(naturalWidth), 0);
    if (wide <= 0) return;
    for (const s of spans) {
      const w = naturalWidth(s);
      const gaps = Math.max(0, glyphCount(s) - 1);
      s.style.letterSpacing = gaps && w + 0.5 < wide ? `${(wide - w) / gaps}px` : "0";
    }
  };

  const show = (k: number) => {
    const st = style();
    el.dataset.style = st;
    el.style.setProperty("--morph-justify", justifyOf(alignOf() === "justify" ? "center" : alignOf()));
    spans.forEach((s, idx) => {
      apply(st, s, idx === k ? 1 : 0, true);
      restore(s, idx);
    });
    fit();
  };

  const scheduleHold = (seed = false) => {
    clock = host();
    timer = clock.setTimeout(beginFade, holdMs(i) * (seed ? Math.random() : 1));
  };

  const beginFade = () => {
    if (dead || !running) return;
    fading = true;
    const from = i;
    const to = (i + 1) % n;
    const dur = fadeMs(from);
    const st = style();
    el.dataset.style = st;
    const t0 = clock.performance.now();
    let lastScramble = 0;
    const step = (now: number) => {
      if (dead || !running) return;
      const f = Math.min(1, (now - t0) / dur);
      const e = st === "morph" || st === "scramble" ? f : f * f * (3 - 2 * f);
      apply(st, spans[from], 1 - e, false);
      apply(st, spans[to], e, true);
      if (st === "scramble" && !htmlSnap && f < 1 && now - lastScramble > 50) {
        spans[to].textContent = scramble(spec.items[to].text, f);
        lastScramble = now;
      }
      if (f < 1) {
        raf = clock.requestAnimationFrame(step);
      } else {
        i = to;
        fading = false;
        show(i);
        scheduleHold();
      }
    };
    raf = clock.requestAnimationFrame(step);
  };

  const play = () => {
    if (dead || running) return;
    running = true;
    scheduleHold(true);
  };

  const pause = () => {
    running = false;
    clock.clearTimeout(timer);
    clock.cancelAnimationFrame(raf);
    if (fading) {
      i = (i + 1) % n;
      fading = false;
      show(i);
    }
  };

  show(0);
  queueMicrotask(fit);

  let io: IntersectionObserver | undefined;
  if (n > 1) {
    queueMicrotask(() => {
      if (dead) return;
      const view = host();
      io = new view.IntersectionObserver((entries) => {
        const visible = entries[entries.length - 1].isIntersecting;
        if (visible) play();
        else pause();
      });
      io.observe(el);
    });
  }

  return {
    el,
    itemEls: spans,
    destroy: () => {
      dead = true;
      pause();
      io?.disconnect();
    },
    captureContent,
    refresh: () => {
      show(i);
      fit();
    },
    play,
  };
}

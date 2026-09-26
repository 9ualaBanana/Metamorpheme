export const STYLES = ["morph", "crossfade", "blur", "slide", "zoom", "scramble"] as const;
export type Style = (typeof STYLES)[number];

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
  align?: "left" | "center" | "right";
}

export interface MorphHandle {
  el: HTMLElement;
  itemEls: HTMLElement[];
  destroy: () => void;
  captureContent: () => void;
  refresh: () => void;
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
      else if (key === "style" && (STYLES as readonly string[]).includes(val)) spec.style = val as Style;
      else if (key === "align" && /^(left|center|right)$/.test(val)) spec.align = val as Spec["align"];
    }
  }

  for (const p of parts) {
    if (!p) continue;
    const m = ITEM.exec(p);
    if (m && (m[2] !== undefined || m[3] !== undefined)) {
      spec.items.push({ text: m[1].trim(), hold: num(m[2]), fade: num(m[3]) });
    } else {
      spec.items.push({ text: p });
    }
  }
  return spec;
}

export function rewriteMorphSeparators(text: string, oldSep: string, newSep: string): string {
  if (!oldSep || oldSep === newSep) return text;
  return text.replace(/\{~(.+?)~\}/g, (full, inner: string) => {
    if (!inner.includes(oldSep)) return full;
    return `{~${inner.split(oldSep).join(newSep)}~}`;
  });
}

/** Fenced-block form: one word per line, optional first line of options. */
export function parseBlock(src: string, separator: string): Spec {
  const lines = src.split("\n").map((l) => l.trim()).filter(Boolean);
  return parseSpec(lines.join(` ${separator} `), separator);
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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
  const justify = spec.align === "left" ? "start" : spec.align === "right" ? "end" : "center";
  el.style.setProperty("--morph-justify", justify);
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
    s.textContent = it.text;
    el.appendChild(s);
    return s;
  });

  const n = spans.length;
  const reduced = reducedMotion();
  const style = (): Style => (reduced ? "crossfade" : spec.style ?? d.style ?? "morph");
  const holdMs = (k: number) => Math.max(0, spec.items[k].hold ?? spec.hold ?? d.hold) * 1000;
  const fadeMs = (k: number) => Math.max(0.05, spec.items[k].fade ?? spec.fade ?? d.fade) * 1000;

  let i = 0;
  let fading = false;
  let running = false;
  let timer = 0;
  let raf = 0;
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
    if (s.textContent !== text) s.textContent = text;
  };

  const show = (k: number) => {
    const st = style();
    el.dataset.style = st;
    spans.forEach((s, idx) => {
      apply(st, s, idx === k ? 1 : 0, true);
      restore(s, idx);
    });
  };

  const scheduleHold = (seed = false) => {
    timer = window.setTimeout(beginFade, holdMs(i) * (seed ? Math.random() : 1));
  };

  const beginFade = () => {
    fading = true;
    const from = i;
    const to = (i + 1) % n;
    const dur = fadeMs(from);
    const st = style();
    el.dataset.style = st;
    const t0 = performance.now();
    let lastScramble = 0;
    const step = (now: number) => {
      const f = Math.min(1, (now - t0) / dur);
      const e = st === "morph" || st === "scramble" ? f : f * f * (3 - 2 * f);
      apply(st, spans[from], 1 - e, false);
      apply(st, spans[to], e, true);
      if (st === "scramble" && !htmlSnap && f < 1 && now - lastScramble > 50) {
        spans[to].textContent = scramble(spec.items[to].text, f);
        lastScramble = now;
      }
      if (f < 1) {
        raf = window.requestAnimationFrame(step);
      } else {
        i = to;
        fading = false;
        show(i);
        scheduleHold();
      }
    };
    raf = window.requestAnimationFrame(step);
  };

  const play = () => {
    if (running) return;
    running = true;
    scheduleHold(true);
  };

  const pause = () => {
    running = false;
    window.clearTimeout(timer);
    window.cancelAnimationFrame(raf);
    if (fading) {
      i = (i + 1) % n;
      fading = false;
      show(i);
    }
  };

  show(0);

  let io: IntersectionObserver | undefined;
  if (n > 1) {
    io = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1].isIntersecting;
      if (visible) play();
      else pause();
    });
    io.observe(el);
  }

  return {
    el,
    itemEls: spans,
    destroy: () => {
      pause();
      io?.disconnect();
    },
    captureContent,
    refresh: () => show(i),
  };
}

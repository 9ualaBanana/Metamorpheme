import { elementWindow, requestElementFrame, requestElementTimeout } from "./animation-clock";
import type { Defaults, Style } from "./morph";

export interface MorphClock {
  now(): number;
  timeout(ms: number, run: () => void): () => void;
  frame(run: (now: number) => void): () => void;
}

export function morphClock(el: HTMLElement): MorphClock {
  return {
    now: () => elementWindow(el).performance.now(),
    timeout: (ms, run) => requestElementTimeout(el, ms, run),
    frame: (run) => requestElementFrame(el, run),
  };
}

export function morphStyle(el: HTMLElement, chosen: Style | undefined, fallback: Style | undefined): Style {
  const reduce = elementWindow(el).matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (reduce) return "crossfade";
  return chosen ?? fallback ?? "zoom";
}

export interface WordPaint {
  text: string;
  opacity: number;
  hit: boolean;
  translateYEm: number;
  scale: number;
  blurPx: number;
}

export interface MorphPaint {
  style: Style;
  fading: boolean;
  outgoing: WordPaint & { index: number };
  incoming: (WordPaint & { index: number }) | null;
}

export function wordPaint(style: Style, text: string, f: number, incoming: boolean): WordPaint {
  const paint: WordPaint = {
    text,
    opacity: 0,
    hit: f > 0.35,
    translateYEm: 0,
    scale: 1,
    blurPx: 0,
  };
  if (f <= 0.001) return paint;
  if (style === "diffuse") {
    const blur = (1 - f) * 12;
    paint.opacity = f;
    paint.blurPx = blur > 0.05 ? blur : 0;
    return paint;
  }
  if (style === "slide") {
    paint.opacity = f;
    paint.translateYEm = (1 - f) * 0.7 * (incoming ? 1 : -1);
    return paint;
  }
  if (style === "zoom") {
    paint.opacity = f;
    paint.scale = incoming ? 0.8 + 0.2 * f : 1 + 0.2 * (1 - f);
    return paint;
  }
  paint.opacity = f;
  return paint;
}

export function playMorph(opts: {
  count: number;
  holdMs: (index: number) => number;
  fadeMs: (index: number) => number;
  style: () => Style;
  text: (index: number) => string;
  clock: MorphClock;
  onPaint: (paint: MorphPaint) => void;
}): { start: () => void; stop: () => void; reveal: () => void; destroy: () => void } {
  const { count, holdMs, fadeMs, style, text, clock, onPaint } = opts;
  let i = 0;
  let fading = false;
  let running = false;
  let dead = false;
  let cancelHold = () => {};
  let cancelFrame = () => {};

  const layer = (index: number, f: number, incoming: boolean): WordPaint & { index: number } => ({
    index,
    ...wordPaint(style(), text(index), f, incoming),
  });

  const emit = (paint: MorphPaint) => {
    if (!dead) onPaint(paint);
  };

  const settled = (index: number): MorphPaint => ({
    style: style(),
    fading: false,
    outgoing: layer(index, 1, true),
    incoming: null,
  });

  const settle = (index: number, hold: boolean) => {
    i = index;
    fading = false;
    emit(settled(index));
    if (hold && running) {
      cancelHold();
      cancelHold = clock.timeout(holdMs(i), beginFade);
    }
  };

  const beginFade = () => {
    if (dead || !running || count < 2) return;
    fading = true;
    const from = i;
    const to = (i + 1) % count;
    const dur = fadeMs(from);
    const t0 = clock.now();
    const step = (now: number) => {
      if (dead || !running) return;
      const f = Math.min(1, (now - t0) / dur);
      const st = style();
      const e = f * f * (3 - 2 * f);
      emit({
        style: st,
        fading: true,
        outgoing: { index: from, ...wordPaint(st, text(from), 1 - e, false) },
        incoming: { index: to, ...wordPaint(st, text(to), e, true) },
      });
      if (f < 1) cancelFrame = clock.frame(step);
      else settle(to, true);
    };
    cancelFrame = clock.frame(step);
  };

  if (count > 0) emit(settled(0));

  return {
    start() {
      if (dead || running || count < 2) return;
      running = true;
      cancelHold = clock.timeout(holdMs(i) * Math.random(), beginFade);
    },
    stop() {
      running = false;
      cancelHold();
      cancelFrame();
      if (fading && count > 0) settle((i + 1) % count, false);
    },
    reveal() {
      if (dead || count < 1) return;
      emit(settled(i));
    },
    destroy() {
      running = false;
      cancelHold();
      cancelFrame();
      if (fading && count > 0) settle((i + 1) % count, false);
      dead = true;
    },
  };
}

export function holdOf(specHold: number | undefined, itemHold: number | undefined, d: Defaults): number {
  return Math.max(0, itemHold ?? specHold ?? d.hold) * 1000;
}

export function fadeOf(specFade: number | undefined, itemFade: number | undefined, d: Defaults): number {
  return Math.max(0.05, itemFade ?? specFade ?? d.fade) * 1000;
}

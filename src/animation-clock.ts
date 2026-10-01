/**
 * Spec: docs/animation-clock.md
 * Every morph timer, frame, and visibility watch goes through this file.
 * Do not call setTimeout, requestAnimationFrame, or IntersectionObserver on a morph from anywhere else.
 */

const ATTACH_FRAMES = 8;

/** Window that contains `el` at this moment. Never store the result across a move into another window. */
export function elementWindow(el: HTMLElement) {
  return el.ownerDocument.defaultView ?? window;
}

export function requestElementTimeout(el: HTMLElement, ms: number, run: () => void): () => void {
  const clock = elementWindow(el);
  const timer = clock.setTimeout(run, ms);
  return () => clock.clearTimeout(timer);
}

export function requestElementFrame(el: HTMLElement, run: (now: number) => void): () => void {
  const clock = elementWindow(el);
  const frame = clock.requestAnimationFrame(run);
  return () => clock.cancelAnimationFrame(frame);
}

export function watchElementVisibility(el: HTMLElement, onChange: (visible: boolean) => void): () => void {
  const view = elementWindow(el);
  const io = new view.IntersectionObserver((entries) => {
    onChange(entries[entries.length - 1].isIntersecting);
  });
  io.observe(el);
  return () => io.disconnect();
}

/**
 * Run after `el` is in a document, on a later frame of that document's window.
 * One microtask first, so the caller can append the element into another window.
 * Then at most eight frames. A microtask loop never yields and freezes note open.
 */
export function whenAttached(el: HTMLElement, run: () => void): { schedule: () => void; cancel: () => void } {
  let frame = 0;
  let waits = 0;
  let generation = 0;
  let clock: Window | null = null;

  const cancel = () => {
    generation++;
    clock?.cancelAnimationFrame(frame);
    frame = 0;
  };

  const step = (token: number) => {
    if (token !== generation) return;
    const view = elementWindow(el);
    clock = view;
    if (!el.isConnected) {
      if (waits++ < ATTACH_FRAMES) frame = view.requestAnimationFrame(() => step(token));
      return;
    }
    waits = 0;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (token !== generation) return;
      if (!el.isConnected) {
        step(token);
        return;
      }
      run();
    });
  };

  const schedule = () => {
    cancel();
    const token = generation;
    waits = 0;
    queueMicrotask(() => step(token));
  };

  return { schedule, cancel };
}

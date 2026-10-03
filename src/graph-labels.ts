import { Workspace } from "obsidian";
import { watchElementVisibility } from "./animation-clock";
import { Defaults, parseSpec, Spec } from "./morph";
import { fadeOf, holdOf, MorphPaint, morphClock, morphStyle, playMorph, WordPaint } from "./morph-play";

interface PixiBlur {
  blur?: number;
  strength?: number;
}

interface PixiText {
  text: string;
  x: number;
  y: number;
  alpha: number;
  visible: boolean;
  scale: { x: number; y: number };
  style?: { fontSize?: number | string };
  parent?: { addChild(child: PixiText): void; removeChild(child: PixiText): void } | null;
  filters: PixiBlur[] | null;
  anchor?: { set(x: number, y: number): void };
  resolution?: number;
  zIndex?: number;
  eventMode?: string;
  destroy(): void;
}

interface PixiApi {
  Text: new (text: string, style: unknown) => PixiText;
  BlurFilter?: new () => PixiBlur;
}

interface GraphNode {
  text?: PixiText | null;
  getDisplayText?: () => string;
  render?: () => void;
}

interface GraphRenderer {
  nodes?: GraphNode[];
  changed?: () => void;
  interactiveEl?: HTMLElement;
}

interface TitleParts {
  prefix: string;
  suffix: string;
  spec: Spec;
}

interface NodeSession {
  sig: string;
  start: () => void;
  stop: () => void;
  destroy: () => void;
}

interface GraphBook {
  nodes: Map<GraphNode, NodeSession>;
  stopWatch: () => void;
  shown: boolean;
}

const books = new Map<GraphRenderer, GraphBook>();

function hasBox(el: HTMLElement): boolean {
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function pixiOf(el: HTMLElement): PixiApi | null {
  const view = el.ownerDocument.defaultView as { PIXI?: PixiApi } | null;
  return view?.PIXI?.Text ? view.PIXI : null;
}

function fontPx(text: PixiText): number {
  const size = text.style?.fontSize;
  const n = typeof size === "number" ? size : parseFloat(String(size ?? ""));
  return Number.isFinite(n) && n > 0 ? n : 16;
}

function morphTitle(display: string, separator: string): TitleParts | null {
  const found = /\{~(.+?)~\}/.exec(display);
  if (!found || found.index === undefined) return null;
  const spec = parseSpec(found[1], separator);
  if (!spec.items.length) return null;
  return {
    prefix: display.slice(0, found.index),
    suffix: display.slice(found.index + found[0].length),
    spec,
  };
}

function line(parts: TitleParts, word: string): string {
  return `${parts.prefix}${word || "\u00a0"}${parts.suffix}`;
}

function setBlur(api: PixiApi | null, sprite: PixiText, px: number, slot: { filter: PixiBlur | null }) {
  if (px <= 0) {
    sprite.filters = null;
    return;
  }
  if (!slot.filter && api?.BlurFilter) slot.filter = new api.BlurFilter();
  if (!slot.filter) return;
  slot.filter.blur = px;
  slot.filter.strength = px;
  sprite.filters = [slot.filter];
}

function placeSprite(sprite: PixiText, base: { x: number; y: number; sx: number; sy: number; alpha: number; visible: boolean }, word: WordPaint, font: number, api: PixiApi | null, slot: { filter: PixiBlur | null }, label: string) {
  if (sprite.text !== label) sprite.text = label;
  sprite.visible = base.visible && word.opacity > 0.001;
  sprite.x = base.x;
  sprite.y = base.y + word.translateYEm * font;
  sprite.scale.x = base.sx * word.scale;
  sprite.scale.y = base.sy * word.scale;
  sprite.alpha = base.alpha * word.opacity;
  setBlur(api, sprite, word.blurPx, slot);
}

function sibling(api: PixiApi, source: PixiText, label: string): PixiText | null {
  if (!source.parent) return null;
  const extra = new api.Text(label, source.style);
  extra.eventMode = "none";
  extra.anchor?.set(0.5, 0);
  extra.resolution = source.resolution;
  extra.zIndex = source.zIndex;
  source.parent.addChild(extra);
  return extra;
}

function bindNode(renderer: GraphRenderer, node: GraphNode, canvas: HTMLElement, d: Defaults, source: string): NodeSession | null {
  const parts = morphTitle(source, d.separator);
  if (!parts || !node.render) return null;
  const original = node.render;
  let paint: MorphPaint | null = null;
  let extra: PixiText | null = null;
  const outgoingBlur = { filter: null as PixiBlur | null };
  const incomingBlur = { filter: null as PixiBlur | null };
  const spec = parts.spec;

  node.render = () => {
    original.call(node);
    const text = node.text;
    if (!text || !paint) return;
    const api = pixiOf(canvas);
    const base = {
      x: text.x,
      y: text.y,
      sx: text.scale.x,
      sy: text.scale.y,
      alpha: text.alpha,
      visible: text.visible,
    };
    const font = fontPx(text);
    placeSprite(text, base, paint.outgoing, font, api, outgoingBlur, line(parts, paint.outgoing.text));
    if (paint.incoming && api) {
      if (!extra || extra.parent !== text.parent) {
        extra?.destroy();
        extra = sibling(api, text, line(parts, paint.incoming.text));
      }
      if (extra) {
        extra.style = text.style;
        placeSprite(extra, base, paint.incoming, font, api, incomingBlur, line(parts, paint.incoming.text));
      }
    } else if (extra) {
      extra.visible = false;
    }
  };

  const playback = playMorph({
    count: spec.items.length,
    holdMs: (k) => holdOf(spec.hold, spec.items[k]?.hold, d),
    fadeMs: (k) => fadeOf(spec.fade, spec.items[k]?.fade, d),
    style: () => morphStyle(canvas, spec.style, d.style),
    text: (k) => spec.items[k]?.text ?? "",
    clock: morphClock(canvas),
    onPaint: (next) => {
      paint = next;
      renderer.changed?.();
    },
  });

  return {
    sig: [d.separator, d.hold, d.fade, d.style, source].join("\0"),
    start: () => playback.start(),
    stop: () => playback.stop(),
    destroy() {
      playback.destroy();
      node.render = original;
      const text = node.text;
      if (text) {
        text.filters = null;
        text.text = node.getDisplayText?.() ?? source;
      }
      if (extra) {
        extra.parent?.removeChild(extra);
        extra.destroy();
        extra = null;
      }
      renderer.changed?.();
    },
  };
}

function bookFor(renderer: GraphRenderer): GraphBook {
  const existing = books.get(renderer);
  if (existing) return existing;
  const book: GraphBook = { nodes: new Map(), stopWatch: () => {}, shown: false };
  const canvas = renderer.interactiveEl;
  if (canvas) {
    const watch = watchElementVisibility(canvas, (visible) => {
      book.shown = visible;
      for (const session of book.nodes.values()) {
        if (visible) session.start();
        else session.stop();
      }
    });
    book.stopWatch = watch;
  }
  books.set(renderer, book);
  return book;
}

export function paintGraphLabels(workspace: Workspace, d: Defaults) {
  const live = new Set<GraphRenderer>();
  for (const type of ["graph", "localgraph"]) {
    for (const leaf of workspace.getLeavesOfType(type)) {
      const renderer = (leaf.view as { renderer?: GraphRenderer }).renderer;
      if (!renderer?.nodes || !renderer.interactiveEl) continue;
      live.add(renderer);
      const book = bookFor(renderer);
      const seen = new Set<GraphNode>();
      for (const node of renderer.nodes) {
        seen.add(node);
        const source = node.getDisplayText?.();
        if (!source || !source.includes("{~")) {
          const stale = book.nodes.get(node);
          if (stale) {
            stale.destroy();
            book.nodes.delete(node);
          }
          continue;
        }
        const sig = [d.separator, d.hold, d.fade, d.style, source].join("\0");
        const current = book.nodes.get(node);
        if (current?.sig === sig) continue;
        current?.destroy();
        const session = bindNode(renderer, node, renderer.interactiveEl, d, source);
        if (!session) {
          book.nodes.delete(node);
          continue;
        }
        book.nodes.set(node, session);
      }
      const awake = book.shown || hasBox(renderer.interactiveEl);
      if (awake) {
        for (const session of book.nodes.values()) session.start();
      }
      for (const [node, session] of book.nodes) {
        if (!seen.has(node)) {
          session.destroy();
          book.nodes.delete(node);
        }
      }
    }
  }
  for (const [renderer, book] of books) {
    if (live.has(renderer)) continue;
    for (const session of book.nodes.values()) session.destroy();
    book.stopWatch();
    books.delete(renderer);
  }
}

export function restoreGraphLabels(workspace: Workspace) {
  for (const [, book] of books) {
    for (const session of book.nodes.values()) session.destroy();
    book.stopWatch();
  }
  books.clear();
  void workspace;
}

import { App, Component, editorLivePreviewField } from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { hydrateMorphMarkdown, peelOuterMarkup, applyOuterMarkup } from "./markdown";
import { createMorph, Defaults, parseSpec, Spec } from "./morph";

type Destroyable = HTMLElement & { __morphDestroy?: () => void };

function linkFromPointer(event: Event): HTMLElement | null {
  const from = (n: EventTarget | null): HTMLElement | null => {
    const node = n as Node | null;
    if (!node || !("instanceOf" in node) || !node.instanceOf(HTMLElement)) return null;
    return node.closest("a, .internal-link, .external-link, button, input, textarea, .internal-embed");
  };
  for (const n of event.composedPath()) {
    const hit = from(n);
    if (hit) return hit;
  }
  if (!("clientX" in event)) return null;
  const { clientX, clientY } = event as MouseEvent;
  for (const n of document.elementsFromPoint(clientX, clientY)) {
    const hit = from(n);
    if (hit) return hit;
  }
  return null;
}

class MorphWidget extends WidgetType {
  constructor(
    private spec: Spec,
    private d: Defaults,
    private app: App,
    private sourcePath: string,
    private host: Component
  ) {
    super();
  }
  eq(other: MorphWidget) {
    return (
      other.sourcePath === this.sourcePath &&
      other.d === this.d &&
      JSON.stringify(other.spec) === JSON.stringify(this.spec)
    );
  }
  toDOM() {
    const handle = createMorph(this.spec, this.d);
    const owner = new Component();
    this.host.addChild(owner);
    void hydrateMorphMarkdown(handle, this.spec, this.app, this.sourcePath, owner);
    const el = handle.el as Destroyable;
    el.__morphDestroy = () => {
      handle.destroy();
      this.host.removeChild(owner);
    };
    return el;
  }
  destroy(dom: HTMLElement) {
    (dom as Destroyable).__morphDestroy?.();
  }
  ignoreEvent(event: Event) {
    if (linkFromPointer(event)) return true;
    if (!("clientX" in event)) return false;
    const { clientX, clientY } = event as MouseEvent;
    return document.elementsFromPoint(clientX, clientY).some(
      (n) => n.instanceOf(HTMLElement) && n.classList.contains("morph-word") && n.querySelector("a")
    );
  }
}

function inCode(state: EditorState, from: number, to: number): boolean {
  let hit = false;
  try {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (/code/i.test(node.name)) {
          hit = true;
          return false;
        }
        return undefined;
      },
    });
  } catch {
    /* tree not ready — treat as not code */
  }
  return hit;
}

export function morphLivePreview(d: Defaults, app: App, sourcePath: () => string, host: Component) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate) {
        const modeChanged =
          u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
        if (u.docChanged || u.viewportChanged || u.selectionSet || modeChanged) {
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;

        const builder = new RangeSetBuilder<Decoration>();
        const { doc, selection } = view.state;
        const path = sourcePath();
        let lastLineEnd = -1;

        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = doc.lineAt(pos);
            pos = line.to + 1;
            if (line.to <= lastLineEnd) continue;
            lastLineEnd = line.to;
            if (!line.text.includes("{~")) continue;

            const re = /\{~(.+?)~\}/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(line.text))) {
              const start = line.from + m.index;
              const end = start + m[0].length;
              if (selection.ranges.some((r) => r.from <= end && r.to >= start)) continue;
              let spec = parseSpec(m[1], d.separator, d.keepEmpty);
              if (!spec.items.length) continue;
              if (inCode(view.state, start, end)) continue;
              const peeled = peelOuterMarkup(line.text.slice(0, m.index), line.text.slice(m.index + m[0].length));
              spec = applyOuterMarkup(spec, peeled.open, peeled.close);
              builder.add(start, end, Decoration.replace({ widget: new MorphWidget(spec, d, app, path, host) }));
            }
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

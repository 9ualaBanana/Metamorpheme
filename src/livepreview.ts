import { editorLivePreviewField } from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { createMorph, Defaults, parseSpec } from "./morph";

type Destroyable = HTMLElement & { __morphDestroy?: () => void };

class MorphWidget extends WidgetType {
  constructor(private raw: string, private d: Defaults) {
    super();
  }
  eq(other: MorphWidget) {
    return other.raw === this.raw;
  }
  toDOM() {
    const { el, destroy } = createMorph(parseSpec(this.raw, this.d.separator), this.d);
    (el as Destroyable).__morphDestroy = destroy;
    return el;
  }
  destroy(dom: HTMLElement) {
    (dom as Destroyable).__morphDestroy?.();
  }
  ignoreEvent() {
    return false;
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

export function morphLivePreview(d: Defaults) {
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
              if (!parseSpec(m[1], d.separator).items.length) continue;
              if (inCode(view.state, start, end)) continue;
              builder.add(start, end, Decoration.replace({ widget: new MorphWidget(m[1], d) }));
            }
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

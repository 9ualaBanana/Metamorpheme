import { EditorState } from "@codemirror/state";
import { ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";

function selectionTouchesMorph(state: EditorState): boolean {
  return state.selection.ranges.some((range) => {
    const start = state.doc.lineAt(Math.min(range.from, range.to));
    const end = state.doc.lineAt(Math.max(range.from, range.to));
    for (let n = start.number; n <= end.number; n++) {
      if (state.doc.line(n).text.includes("{~")) return true;
    }
    return false;
  });
}

/**
 * Live preview must not rebuild widgets on a caret move that does not touch a morph.
 * Each rebuild constructs a morph per span, and each morph waits to be attached.
 * Opening a note moves the caret several times; doing that for every move is the freeze.
 * A move onto, inside, or off a morph line still rebuilds, so the source shows while editing.
 */
export function rebuildLivePreview(update: ViewUpdate): boolean {
  const modeChanged =
    update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false);
  const throughMorph =
    update.selectionSet && (selectionTouchesMorph(update.startState) || selectionTouchesMorph(update.state));
  return update.docChanged || update.viewportChanged || modeChanged || throughMorph;
}

/**
 * Title rows in the file explorer appear without a vault event, so they need an observer.
 * That observer has to be the explorer leaf only. `workspace.containerEl` also contains
 * the editor: opening a note mutates every node there on one turn and freezes the UI.
 * Our own morph DOM is ignored so decorating a title does not schedule another pass.
 */
export function watchExplorerTitles(
  workspace: HTMLElement,
  onChange: () => void,
): { followFileExplorer: () => void; stop: () => void } {
  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      const el = record.target.instanceOf(Element) ? record.target : record.target.parentElement;
      return !!el && !el.closest(".morph-text");
    });
    if (relevant) onChange();
  });

  return {
    followFileExplorer() {
      observer.disconnect();
      for (const root of Array.from(workspace.querySelectorAll('[data-type="file-explorer"]'))) {
        if (root.instanceOf(Element)) observer.observe(root, { childList: true, subtree: true });
      }
    },
    stop() {
      observer.disconnect();
    },
  };
}

import { keymap } from "@codemirror/view";
import { App } from "obsidian";

export function autoPairBracketsOn(app: App): boolean {
  const vault = app.vault as App["vault"] & { getConfig?: (key: string) => unknown };
  return vault.getConfig?.("autoPairBrackets") !== false;
}

export function morphAutoClose(app: App) {
  return keymap.of([
    {
      key: "~",
      run(view) {
        if (!autoPairBracketsOn(app)) return false;
        const { state } = view;
        const sel = state.selection.main;
        if (!sel.empty) return false;
        const before = state.doc.sliceString(sel.from - 1, sel.from);
        const after = state.doc.sliceString(sel.from, sel.from + 1);
        if (before !== "{" || after !== "}") return false;
        view.dispatch({
          changes: { from: sel.from, insert: "~  ~" },
          selection: { anchor: sel.from + 2 },
        });
        return true;
      },
    },
  ]);
}

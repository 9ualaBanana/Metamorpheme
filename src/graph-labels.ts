import { Workspace } from "obsidian";

const GRAPH_VIEW_TYPES = ["graph", "localgraph"];
const DISPLAY_LABEL = "mumbo jumbo";

interface GraphLabelNode {
  text?: { text: string } | null;
  getDisplayText: () => string;
}

interface GraphRenderer {
  nodes?: GraphLabelNode[];
  changed?: () => void;
}

const savedDisplayText = new WeakMap<GraphLabelNode, () => string>();

function graphRenderers(workspace: Workspace): GraphRenderer[] {
  const found: GraphRenderer[] = [];
  for (const type of GRAPH_VIEW_TYPES) {
    for (const leaf of workspace.getLeavesOfType(type)) {
      const renderer = (leaf.view as { renderer?: GraphRenderer }).renderer;
      if (renderer?.nodes) found.push(renderer);
    }
  }
  return found;
}

export function paintGraphLabels(workspace: Workspace) {
  for (const renderer of graphRenderers(workspace)) {
    let dirty = false;
    for (const node of renderer.nodes ?? []) {
      if (!node.getDisplayText || savedDisplayText.has(node)) continue;
      savedDisplayText.set(node, node.getDisplayText);
      node.getDisplayText = () => DISPLAY_LABEL;
      if (node.text) node.text.text = DISPLAY_LABEL;
      dirty = true;
    }
    if (dirty) renderer.changed?.();
  }
}

export function restoreGraphLabels(workspace: Workspace) {
  for (const renderer of graphRenderers(workspace)) {
    let dirty = false;
    for (const node of renderer.nodes ?? []) {
      const original = savedDisplayText.get(node);
      if (!original) continue;
      node.getDisplayText = original;
      savedDisplayText.delete(node);
      if (node.text) node.text.text = node.getDisplayText();
      dirty = true;
    }
    if (dirty) renderer.changed?.();
  }
}

export const OUTER_STYLES = ["strong", "em", "strike", "highlight"] as const;
export type OuterStyle = (typeof OUTER_STYLES)[number];

const PAINT: Record<OuterStyle, { tag: "strong" | "em" | "del" | "mark"; css: Record<string, string> }> = {
  strong: { tag: "strong", css: { fontWeight: "bold" } },
  em: { tag: "em", css: { fontStyle: "italic" } },
  strike: { tag: "del", css: { textDecoration: "line-through" } },
  highlight: { tag: "mark", css: { backgroundColor: "var(--text-highlight-bg)" } },
};

const BLOCK = new Set(["P", "DIV", "LI", "TD", "TH", "BODY", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "UL", "OL"]);

function escaped(source: string, index: number): boolean {
  let n = 0;
  while (index - 1 - n >= 0 && source[index - 1 - n] === "\\") n++;
  return n % 2 === 1;
}

function isPunct(ch: string): boolean {
  return ch !== "" && /[^\s\p{L}\p{N}]/u.test(ch);
}

function maskMorphAndCode(source: string, from: number, to: number): boolean[] {
  const skip = Array.from({ length: source.length }, () => false);
  for (let i = from; i < to && i < skip.length; i++) skip[i] = true;
  for (let i = 0; i < source.length; i++) {
    if (skip[i] || source[i] !== "`" || escaped(source, i)) continue;
    let n = 0;
    while (source[i + n] === "`") n++;
    const fence = source.indexOf("`".repeat(n), i + n);
    const end = fence < 0 ? source.length : fence + n;
    for (let k = i; k < end && k < skip.length; k++) skip[k] = true;
    i = end - 1;
  }
  return skip;
}

function flank(source: string, pos: number, len: number, ch: "*" | "_"): { canOpen: boolean; canClose: boolean } {
  const before = source[pos - 1] ?? "";
  const after = source[pos + len] ?? "";
  const beforeWs = before === "" || /\s/u.test(before);
  const afterWs = after === "" || /\s/u.test(after);
  const left = !afterWs && (!isPunct(after) || beforeWs || isPunct(before));
  const right = !beforeWs && (!isPunct(before) || afterWs || isPunct(after));
  if (ch === "_") {
    const alnum = /[\p{L}\p{N}]/u;
    return { canOpen: left && !alnum.test(before), canClose: right && !alnum.test(after) };
  }
  return { canOpen: left, canClose: right };
}

function mergeOuterStyle(layers: readonly (readonly OuterStyle[])[]): OuterStyle[] {
  const marks: OuterStyle[] = [];
  for (const layer of layers) {
    for (const mark of layer) if (!marks.includes(mark)) marks.push(mark);
  }
  return marks;
}

function markFromNode(n: HTMLElement): OuterStyle[] {
  const tag = n.tagName;
  const marks: OuterStyle[] = [];
  if (tag === "STRONG" || tag === "B" || n.classList.contains("cm-strong")) marks.push("strong");
  if (tag === "EM" || tag === "I" || n.classList.contains("cm-em")) marks.push("em");
  if (tag === "DEL" || tag === "S" || tag === "STRIKE" || n.classList.contains("cm-strikethrough")) marks.push("strike");
  if (tag === "MARK" || n.classList.contains("cm-highlight")) marks.push("highlight");
  return marks;
}

function checkedTask(el: HTMLElement): boolean {
  const host = el.closest("[data-task], .task-list-item");
  if (!host) return false;
  const status = host.getAttribute("data-task");
  if (status !== null) return /^x$/i.test(status.trim());
  return host.classList.contains("is-checked");
}

function outerStyleFromHost(el: HTMLElement): OuterStyle[] {
  const inline: OuterStyle[] = [];
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (BLOCK.has(n.tagName)) break;
    for (const mark of markFromNode(n)) if (!inline.includes(mark)) inline.push(mark);
  }
  inline.reverse();
  return mergeOuterStyle([checkedTask(el) ? ["strike"] : [], inline]);
}

export function outerStyleFromSource(source: string, from: number, to: number): OuterStyle[] {
  const skip = maskMorphAndCode(source, from, to);
  const runs: {
    ch: "*" | "_";
    pos: number;
    len: number;
    canOpen: boolean;
    canClose: boolean;
    used: number;
  }[] = [];
  const tokens: { kind: "strike" | "highlight"; pos: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    if (skip[i] || escaped(source, i)) continue;
    if (source.startsWith("~~", i)) {
      tokens.push({ kind: "strike", pos: i });
      i += 1;
      continue;
    }
    if (source.startsWith("==", i)) {
      tokens.push({ kind: "highlight", pos: i });
      i += 1;
      continue;
    }
    const ch = source[i];
    if (ch !== "*" && ch !== "_") continue;
    let len = 0;
    while (source[i + len] === ch) len++;
    runs.push({ ch, pos: i, len, used: 0, ...flank(source, i, len, ch) });
    i += len - 1;
  }

  const found: { mark: OuterStyle; pos: number }[] = [];
  const open: { kind: "strike" | "highlight"; pos: number }[] = [];
  for (const tok of tokens) {
    const top = open.length && open[open.length - 1].kind === tok.kind ? open.pop() : undefined;
    if (!top) {
      open.push(tok);
      continue;
    }
    if (top.pos + 2 <= from && tok.pos >= to) found.push({ mark: tok.kind, pos: top.pos });
  }

  for (let i = 0; i < runs.length; i++) {
    const closer = runs[i];
    if (!closer.canClose) continue;
    for (let j = i - 1; j >= 0; j--) {
      const opener = runs[j];
      if (opener.ch !== closer.ch || !opener.canOpen) continue;
      const openLeft = opener.len - opener.used;
      const closeLeft = closer.len - closer.used;
      if (!openLeft || !closeLeft) continue;
      if (
        opener.canClose &&
        closer.canOpen &&
        (opener.len + closer.len) % 3 === 0 &&
        opener.len % 3 !== 0 &&
        closer.len % 3 !== 0
      ) {
        continue;
      }
      const use = Math.min(openLeft, closeLeft);
      opener.used += use;
      closer.used += use;
      if (opener.pos + opener.len <= from && closer.pos >= to) {
        if (use >= 2) found.push({ mark: "strong", pos: opener.pos });
        if (use % 2 === 1) found.push({ mark: "em", pos: opener.pos });
      }
      break;
    }
  }

  found.sort((a, b) => a.pos - b.pos);
  return mergeOuterStyle([found.map((hit) => hit.mark)]);
}

export function resolveOuterStyle(fromSource: readonly OuterStyle[], el: HTMLElement): OuterStyle[] {
  return mergeOuterStyle([outerStyleFromHost(el), fromSource]);
}

export function paintOuterStyle(el: HTMLElement, marks: readonly OuterStyle[]) {
  for (const mark of [...marks].reverse()) {
    const nodes = Array.from(el.childNodes);
    if (!nodes.length) return;
    const wrap = el.createEl(PAINT[mark].tag);
    wrap.append(...nodes);
    wrap.setCssStyles(PAINT[mark].css);
  }
}

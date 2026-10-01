import {
  App,
  Editor,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Notice,
  Plugin,
  PluginSettingTab,
  SettingDefinitionItem,
  TFile,
} from "obsidian";
import { morphLivePreview } from "./livepreview";
import { watchExplorerTitles } from "./note-open";
import { morphAutoClose } from "./autoclose";
import { applyOuterMarkup, hydrateMorphMarkdown, markupFromAncestors, peelOuterMarkup } from "./markdown";
import {
  ALIGN_LABELS,
  ALIGNS,
  createMorph,
  Defaults,
  FILTER_ID,
  MorphHandle,
  parseSpec,
  rewriteMorphSeparators,
  STYLE_LABELS,
  STYLES,
} from "./morph";

interface MorphSettings extends Defaults {
  /** master switch for morphing note titles */
  morphTitles: boolean;
  /** morph the big inline title at the top of a note */
  titleInline: boolean;
  /** morph the tab title and the view-header title */
  titleHeader: boolean;
  /** morph file and folder names in the file explorer */
  titleExplorer: boolean;
  distinctTitleSeparator: boolean;
  titleSeparator: string;
  rewriteOnSeparatorChange: boolean;
  autoCloseMorph: boolean;
}

const DEFAULTS: MorphSettings = {
  hold: 2,
  fade: 1,
  style: "morph",
  align: "center",
  separator: ";",
  keepEmpty: true,
  morphTitles: true,
  titleInline: true,
  titleHeader: true,
  titleExplorer: true,
  distinctTitleSeparator: false,
  titleSeparator: ";",
  rewriteOnSeparatorChange: true,
  autoCloseMorph: true,
};

const INLINE_TITLE_SEL = ".inline-title";
const HEADER_TITLE_SEL = ".view-header-title, .workspace-tab-header-inner-title";
const EXPLORER_SEL = ".nav-file-title-content, .nav-folder-title-content";

class MorphChild extends MarkdownRenderChild {
  constructor(el: HTMLElement, private cleanup: () => void) {
    super(el);
  }
  onunload() {
    this.cleanup();
  }
}

interface TitleState {
  /** the file name text exactly as Obsidian had it */
  raw: string;
  handles: MorphHandle[];
}

export default class MorphTextPlugin extends Plugin {
  settings: MorphSettings = { ...DEFAULTS };
  private svg?: SVGSVGElement;

  /** title elements currently showing morph text */
  private titles = new Map<HTMLElement, TitleState>();
  private titleTimer = 0;
  private appliedSeparator = DEFAULTS.separator;
  private appliedTitleSeparator = DEFAULTS.titleSeparator;
  private rewriting = false;

  async onload() {
    const data: unknown = await this.loadData();
    if (data && typeof data === "object") Object.assign(this.settings, data);
    const distinct =
      data && typeof data === "object" ? (data as { distinctTitleSeparator?: unknown }).distinctTitleSeparator : undefined;
    if (typeof distinct !== "boolean") {
      this.settings.distinctTitleSeparator = this.settings.titleSeparator !== this.settings.separator;
    }
    if (!(STYLES as readonly string[]).includes(this.settings.style)) this.settings.style = "morph";
    if (!(ALIGNS as readonly string[]).includes(this.settings.align)) this.settings.align = "center";
    this.appliedSeparator = this.settings.separator;
    this.appliedTitleSeparator = this.titleSep();
    this.installFilter();

    // Reading view: inline {~ a | b ~}
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (el.closest(".morph-text, .morph-word")) return;
      this.renderMorphsInElement(el, ctx);
    }, 10000);

    this.registerEditorExtension(
      morphLivePreview(
        this.settings,
        this.app,
        () => this.app.workspace.getActiveFile()?.path ?? "",
        this
      )
    );
    this.registerEditorExtension(
      morphAutoClose(() => this.settings.autoCloseMorph, this.app)
    );

    this.addCommand({
      id: "insert-morph-set",
      name: "Insert morph set",
      editorCallback: (editor: Editor) => this.insertMorphSet(editor),
    });

    this.addSettingTab(new MorphSettingTab(this.app, this));

    this.setupTitles();
  }

  onunload() {
    window.clearTimeout(this.titleTimer);
    this.restoreAllTitles();
    this.svg?.remove();
  }

  async flushSeparatorRewrite() {
    if (this.rewriting) return;
    this.rewriting = true;
    try {
      await this.runSeparatorRewrite();
    } finally {
      this.rewriting = false;
    }
  }

  private async runSeparatorRewrite() {
    const s = this.settings;
    const notesFrom = this.appliedSeparator;
    const notesTo = s.separator;
    const titlesFrom = this.appliedTitleSeparator;
    const titlesTo = this.titleSep();

    if (!s.rewriteOnSeparatorChange) {
      this.appliedSeparator = notesTo;
      this.appliedTitleSeparator = titlesTo;
      return;
    }

    let notes = 0;
    let titles = 0;
    if (notesFrom && notesTo && notesFrom !== notesTo) {
      notes = await this.rewriteNoteSeparators(notesFrom, notesTo);
    }
    if (titlesFrom && titlesTo && titlesFrom !== titlesTo) {
      titles = await this.rewriteTitleSeparators(titlesFrom, titlesTo);
    }

    this.appliedSeparator = notesTo;
    this.appliedTitleSeparator = titlesTo;

    if (notes || titles) {
      const parts: string[] = [];
      if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
      if (titles) parts.push(`${titles} title${titles === 1 ? "" : "s"}`);
      new Notice(`Updated morph separators in ${parts.join(" and ")}.`);
    }
  }

  private async rewriteNoteSeparators(from: string, to: string): Promise<number> {
    let changed = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      await this.app.vault.process(file, (data) => {
        const next = rewriteMorphSeparators(data, from, to);
        if (next !== data) changed++;
        return next;
      });
    }
    return changed;
  }

  private async rewriteTitleSeparators(from: string, to: string): Promise<number> {
    const items = this.app.vault.getAllLoadedFiles().slice();
    items.sort((a, b) => b.path.split("/").length - a.path.split("/").length || b.path.length - a.path.length);

    let changed = 0;
    for (const item of items) {
      const nextName = rewriteMorphSeparators(item.name, from, to);
      if (nextName === item.name) continue;
      const parent = item.parent?.path ?? "";
      const dest = parent ? `${parent}/${nextName}` : nextName;
      if (this.app.vault.getAbstractFileByPath(dest)) {
        new Notice(`Skipped rename: ${dest} already exists.`);
        continue;
      }
      try {
        if (item instanceof TFile) await this.app.fileManager.renameFile(item, dest);
        else await this.app.vault.rename(item, dest);
        changed++;
      } catch {
        new Notice(`Could not rename ${item.path}.`);
      }
    }
    return changed;
  }

  private titleSep(): string {
    const s = this.settings;
    return (s.distinctTitleSeparator ? s.titleSeparator : s.separator) || ";";
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private installFilter() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "morph-svg-filter");
    const defs = document.createElementNS(ns, "defs");
    const filter = document.createElementNS(ns, "filter");
    filter.setAttribute("id", FILTER_ID);
    filter.setAttribute("x", "-20%");
    filter.setAttribute("y", "-60%");
    filter.setAttribute("width", "140%");
    filter.setAttribute("height", "220%");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const matrix = document.createElementNS(ns, "feColorMatrix");
    matrix.setAttribute("in", "SourceGraphic");
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 255 -140");
    filter.appendChild(matrix);
    defs.appendChild(filter);
    svg.appendChild(defs);
    document.body.appendChild(svg);
    this.svg = svg;
  }

  private renderMorphsInElement(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const nodes = this.morphTextNodes(el);
    if (!nodes.length) return;
    const text = nodes.map((n) => n.nodeValue ?? "").join("");
    if (!text.includes("{~")) return;

    const matches = [...text.matchAll(/\{~(.+?)~\}/g)];
    if (!matches.length) return;

    const info = ctx.getSectionInfo(el);
    const sourceMatches = info?.text ? [...info.text.matchAll(/\{~(.+?)~\}/g)] : [];
    const useSource = sourceMatches.length === matches.length;

    const indexAt = (index: number): { node: Text; offset: number } | null => {
      let acc = 0;
      for (const node of nodes) {
        const len = node.nodeValue?.length ?? 0;
        if (index <= acc + len) return { node, offset: index - acc };
        acc += len;
      }
      return null;
    };

    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      if (m.index === undefined) continue;
      const raw = useSource ? sourceMatches[i][1] : m[1];
      let spec = parseSpec(raw, this.settings.separator, this.settings.keepEmpty);
      if (!spec.items.length) continue;
      if (useSource && info?.text && sourceMatches[i].index !== undefined) {
        const sm = sourceMatches[i];
        const peeled = peelOuterMarkup(
          info.text.slice(0, sm.index),
          info.text.slice(sm.index + sm[0].length)
        );
        spec = applyOuterMarkup(spec, peeled.open, peeled.close);
      }
      const from = indexAt(m.index);
      const to = indexAt(m.index + m[0].length);
      if (!from || !to) continue;
      if (from.node.parentElement?.closest("code, pre")) continue;

      const range = el.ownerDocument.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);

      const handle = createMorph(spec, this.settings);
      const child = new MorphChild(handle.el, handle.destroy);
      ctx.addChild(child);
      range.deleteContents();
      range.insertNode(handle.el);
      if (!useSource) {
        const peeled = markupFromAncestors(handle.el);
        spec = applyOuterMarkup(spec, peeled.open, peeled.close);
      }
      void hydrateMorphMarkdown(handle, spec, this.app, ctx.sourcePath, child);
    }
  }

  private morphTextNodes(root: HTMLElement): Text[] {
    const nodes: Text[] = [];
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (n.parentElement?.closest("code, pre, .morph-text, .morph-word")) continue;
      nodes.push(n);
    }
    return nodes;
  }

  /** Splits text around {~ ... ~} and returns a fragment with morph elements in place. */
  private buildFragment(text: string, sep: string): { frag: DocumentFragment; handles: MorphHandle[] } | null {
    const re = /\{~(.+?)~\}/g;
    const frag = createFragment();
    const handles: MorphHandle[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = parseSpec(m[1], sep, this.settings.keepEmpty);
      if (!spec.items.length) continue;
      frag.append(text.slice(last, m.index));
      const handle = createMorph(spec, this.settings);
      frag.append(handle.el);
      handles.push(handle);
      last = m.index + m[0].length;
    }
    if (!handles.length) return null;
    frag.append(text.slice(last));
    return { frag, handles };
  }

  // ───────────────────────── note titles ─────────────────────────
  //
  // A note named  "Say {~ Mean ; Do ; Ship ~}"  shows morphing text in its title.
  // Per-word timing is limited to "@hold". hold= / fade= / style= go in the first segment.

  private setupTitles() {
    const schedule = (delay = 120) => {
      window.clearTimeout(this.titleTimer);
      this.titleTimer = window.setTimeout(() => this.scanTitles(), delay);
    };

    const explorerTitles = watchExplorerTitles(this.app.workspace.containerEl, () => schedule(100));

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      explorerTitles.followFileExplorer();
      schedule();
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => schedule()));
    this.registerEvent(this.app.workspace.on("file-open", () => schedule()));
    this.registerEvent(this.app.vault.on("rename", () => schedule()));
    this.app.workspace.onLayoutReady(() => {
      explorerTitles.followFileExplorer();
      schedule();
    });

    this.registerInterval(window.setInterval(() => this.scanTitles(false), 2000));

    this.register(() => explorerTitles.stop());

    // Editing a title: show the real file name while focused, morph again afterwards.
    this.registerDomEvent(document, "focusin", (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      for (const el of this.titles.keys()) {
        if (el === target || el.contains(target)) {
          this.restoreTitle(el, true);
          break;
        }
      }
    });
    this.registerDomEvent(document, "focusout", () => schedule(400));
  }

  /** Decorates every title element whose text contains {~ ... ~}. */
  scanTitles(withExplorer = true) {
    for (const [el, st] of this.titles) {
      if (!el.isConnected) {
        st.handles.forEach((h) => h.destroy());
        this.titles.delete(el);
      }
    }

    const s = this.settings;
    if (!s.morphTitles) return;

    const targets: HTMLElement[] = [];
    if (s.titleInline) targets.push(...Array.from(document.querySelectorAll<HTMLElement>(INLINE_TITLE_SEL)));
    if (s.titleHeader) targets.push(...Array.from(document.querySelectorAll<HTMLElement>(HEADER_TITLE_SEL)));
    if (s.titleExplorer && withExplorer) {
      targets.push(...Array.from(document.querySelectorAll<HTMLElement>(EXPLORER_SEL)));
    }
    targets.forEach((el) => this.decorateTitle(el));
  }

  private decorateTitle(el: HTMLElement) {
    const existing = this.titles.get(el);
    if (existing) {
      const first = existing.handles[0]?.el;
      if (first && first.isConnected && el.contains(first)) return; // still ours
      // Obsidian rewrote the element (rename, file switch): drop the stale state
      existing.handles.forEach((h) => h.destroy());
      this.titles.delete(el);
    }

    if (el.contains(document.activeElement)) return; // being edited right now

    const raw = el.textContent ?? "";
    if (!raw.includes("{~")) return;

    const built = this.buildFragment(raw, this.titleSep());
    if (!built) return;

    el.empty();
    el.appendChild(built.frag);
    this.titles.set(el, { raw, handles: built.handles });
  }

  private restoreTitle(el: HTMLElement, placeCaret = false) {
    const st = this.titles.get(el);
    if (!st) return;
    st.handles.forEach((h) => h.destroy());
    this.titles.delete(el);
    el.textContent = st.raw;

    if (placeCaret && el.isContentEditable) {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  private restoreAllTitles() {
    for (const el of Array.from(this.titles.keys())) this.restoreTitle(el);
  }

  /** Call after any title-related setting changes. */
  refreshTitles() {
    this.restoreAllTitles();
    this.scanTitles();
  }

  // ───────────────────────── commands ─────────────────────────

  private wrapLine(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("{~")) return raw;
    const parts = this.listParts(trimmed);
    if (!parts) return raw;
    const sep = this.settings.separator || ";";
    const lead = raw.match(/^\s*/)?.[0] ?? "";
    const trail = raw.match(/\s*$/)?.[0] ?? "";
    return `${lead}{~ ${parts.join(` ${sep} `)} ~}${trail}`;
  }

  private insertMorphSet(editor: Editor) {
    const sel = editor.getSelection();
    if (sel) {
      if (sel.includes("\n")) {
        const next = sel.split("\n").map((line) => this.wrapLine(line)).join("\n");
        if (next !== sel) {
          editor.replaceSelection(next);
          return;
        }
      } else {
        const converted = this.wrapLine(sel);
        if (converted !== sel) {
          editor.replaceSelection(converted);
          return;
        }
      }
    }
    this.insertInline(editor);
  }

  private insertInline(editor: Editor) {
    const sep = this.settings.separator.trim() || ";";
    const sel = editor.getSelection();
    if (sel) {
      const parts = (sel.includes("\n") ? sel.split("\n") : sel.includes(sep) ? sel.split(sep) : sel.split(","))
        .map((s) => s.trim());
      if (this.settings.keepEmpty ? parts.some((p) => p.length) : parts.filter(Boolean).length) {
        const items = this.settings.keepEmpty ? parts : parts.filter(Boolean);
        editor.replaceSelection(`{~ ${items.join(` ${sep} `)} ~}`);
        return;
      }
    }
    const from = editor.getCursor("from");
    editor.replaceSelection(`{~  ${sep} ~}`);
    editor.setCursor({ line: from.line, ch: from.ch + 3 });
  }

  private listParts(text: string): string[] | null {
    const pipes: number[] = [];
    const slashes: number[] = [];
    for (let i = 0; i < text.length; ) {
      const skip = this.skipListChunk(text, i);
      if (skip !== i) {
        i = skip;
        continue;
      }
      if (text[i] === "|" && text[i - 1] !== "\\") pipes.push(i);
      else if (text[i] === "/" && text[i - 1] !== "\\") slashes.push(i);
      i++;
    }
    const seps = pipes.length ? pipes : slashes.filter((i) => this.slashIsListSep(text, i));
    if (!seps.length) return null;
    const parts: string[] = [];
    let prev = 0;
    for (const i of seps) {
      parts.push(text.slice(prev, i).trim());
      prev = i + 1;
    }
    parts.push(text.slice(prev).trim());
    const items = this.settings.keepEmpty ? parts : parts.filter(Boolean);
    return items.length >= 2 ? items : null;
  }

  private skipListChunk(text: string, i: number): number {
    if (text.startsWith("[[", i)) {
      const end = text.indexOf("]]", i + 2);
      return end < 0 ? i : end + 2;
    }
    if (text[i] === "[") {
      const rb = text.indexOf("]", i + 1);
      if (rb >= 0 && text[rb + 1] === "(") {
        let depth = 1;
        let j = rb + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") depth--;
          j++;
        }
        return j;
      }
    }
    if (text.startsWith("{~", i)) {
      const end = text.indexOf("~}", i + 2);
      return end < 0 ? i : end + 2;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      return end < 0 ? i : end + 1;
    }
    if (text[i] === "\\" && i + 1 < text.length) return i + 2;
    return i;
  }

  private slashIsListSep(text: string, i: number): boolean {
    if (text[i - 1] === "/" || text[i + 1] === "/") return false;
    const left = text.slice(0, i).trimEnd();
    return !/[a-z][a-z0-9+.-]*:[^\s|]*$/i.test(left);
  }

  private inMorphSpan(text: string, offset: number): boolean {
    const open = text.lastIndexOf("{~", offset);
    if (open < 0) return false;
    const prevClose = text.lastIndexOf("~}", offset);
    if (prevClose > open) return false;
    const close = text.indexOf("~}", offset);
    return close >= 0;
  }

}

class MorphSettingTab extends PluginSettingTab {
  private previews: MorphHandle[] = [];

  constructor(app: App, private plugin: MorphTextPlugin) {
    super(app, plugin);
  }

  override hide() {
    const active = this.containerEl.ownerDocument.activeElement;
    if (active && active.instanceOf(HTMLElement) && this.containerEl.contains(active)) active.blur();
    this.previews.forEach((h) => h.destroy());
    this.previews = [];
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const styleOptions: Record<string, string> = {};
    for (const s of STYLES) styleOptions[s] = STYLE_LABELS[s];
    const alignOptions: Record<string, string> = {};
    for (const a of ALIGNS) alignOptions[a] = ALIGN_LABELS[a];
    const titlesOn = () => this.plugin.settings.morphTitles;
    const showTitleSep = () => titlesOn() && this.plugin.settings.distinctTitleSeparator;
    return [
      {
        type: "group",
        heading: "Metamorphosis",
        items: [
          {
            name: "Metamorphosis style",
            desc: "Default metamorphosis animation.",
            control: { type: "dropdown", key: "style", options: styleOptions },
          },
          {
            name: "Alignment",
            desc: "How morphemes sit in the space of the longest one. Override per set with align=.",
            control: { type: "dropdown", key: "align", options: alignOptions },
          },
          {
            name: "Metamorphosis duration",
            desc: "Interval in seconds during which metamorphosis takes place.",
            control: { type: "slider", key: "fade", min: 0.1, max: 5, step: 0.1 },
          },
          {
            name: "No metamorphosis duration",
            desc: "Interval in seconds during which morpheme stays visible before metamorphosis takes place.",
            control: { type: "slider", key: "hold", min: 0.2, max: 10, step: 0.1 },
          }
        ],
      },
      {
        type: "group",
        heading: "Preview",
        items: [
          {
            name: "Preview",
            searchable: false,
            render: (setting) => {
              setting.settingEl.addClass("morph-preview-setting");
              setting.infoEl.hide();
              setting.controlEl.hide();
              const host = setting.settingEl.createDiv({ cls: "morph-block" });
              this.fillPreview(host);
              return () => {
                this.previews.forEach((h) => h.destroy());
                this.previews = [];
              };
            },
          },
        ],
      },
      {
        name: "Morphemes separator",
        desc: "Symbol to separate morphemes.",
        render: (setting) => {
          setting.addText((t) => {
            t.setValue(this.plugin.settings.separator).setPlaceholder(";");
            this.commitTextOnLeave(t.inputEl, async (v) => {
              if (this.plugin.settings.separator === v) return;
              this.plugin.settings.separator = v;
              await this.plugin.saveSettings();
              await this.plugin.flushSeparatorRewrite();
            });
          });
        },
      },
      {
        name: "Keep empty morphemes",
        desc: "When a set has empty slots next to filled ones, keep those empty slots in the animation.",
        control: { type: "toggle", key: "keepEmpty" },
      },
      {
        name: "Rewrite metamorphemes on separator change",
        desc: "Update separators inside existing metamorphemes across the vault.",
        control: { type: "toggle", key: "rewriteOnSeparatorChange" },
      },
      {
        name: "Auto-close {~  ~}",
        desc: "When enabled, typing ~ inside {} inserts {~  ~} with the cursor in the middle. Requires `Settings → Editor → Auto pair brackets` being enabled.",
        control: { type: "toggle", key: "autoCloseMorph" },
      },
      {
        type: "group",
        heading: "Titles",
        items: [
          {
            name: "Morph note titles",
            desc: "Master switch for morphing note titles.",
            control: { type: "toggle", key: "morphTitles" },
          },
          {
            name: "Editor",
            desc: "The title at the top of the note editor.",
            visible: titlesOn,
            control: { type: "toggle", key: "titleInline" },
          },
          {
            name: "Tab and header",
            desc: "The title shown in the tab and in the note header.",
            visible: titlesOn,
            control: { type: "toggle", key: "titleHeader" },
          },
          {
            name: "File explorer",
            desc: "File and folder names in the sidebar.",
            visible: titlesOn,
            control: { type: "toggle", key: "titleExplorer" },
          },
          {
            name: "Use different separator",
            desc: "Use different morphemes separator for titles.",
            visible: titlesOn,
            control: { type: "toggle", key: "distinctTitleSeparator" },
          },
          {
            name: "Morphemes separator",
            desc: 'Symbol to separate morphemes in note titles. Forbidden symbols: * " \\ / < > : | ? # ^ [ ].',
            visible: showTitleSep,
            render: (setting) => {
              setting.addText((t) => {
                t.setValue(this.plugin.settings.titleSeparator).setPlaceholder(";");
                this.commitTextOnLeave(t.inputEl, async (v) => {
                  if (this.plugin.settings.titleSeparator === v) return;
                  this.plugin.settings.titleSeparator = v;
                  await this.plugin.saveSettings();
                  this.plugin.refreshTitles();
                  await this.plugin.flushSeparatorRewrite();
                });
              });
            },
          },
        ],
      },
    ];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    if (key === "morphTitles" && value === true) {
      settings.titleInline = true;
      settings.titleHeader = true;
      settings.titleExplorer = true;
      settings.distinctTitleSeparator = false;
    }
    await super.setControlValue(key, value);
    if (key === "style" || key === "align" || key === "fade" || key === "hold" || key === "keepEmpty") {
      this.updatePreview();
    }
    if (key === "titleInline" || key === "titleHeader" || key === "titleExplorer") {
      this.plugin.refreshTitles();
    }
    if (key === "morphTitles" || key === "distinctTitleSeparator") {
      this.refreshDomState();
      this.plugin.refreshTitles();
      await this.plugin.flushSeparatorRewrite();
    }
  }

  private fillPreview(host: HTMLElement) {
    this.previews.forEach((h) => h.destroy());
    this.previews = [];
    host.empty();
    const d = this.plugin.settings;
    const add = (parent: HTMLElement, words: string[]) => {
      const handle = createMorph({ items: words.map((text) => ({ text })) }, d);
      this.previews.push(handle);
      parent.appendChild(handle.el);
    };
    const line = () => host.createDiv({ cls: "morph-preview-line" });
    let row = line();
    add(row, ["Prolix", "Verbose", "Diffuse"]);
    row.append(" & ");
    add(row, ["laconic", "concise"]);
    row.append(".");
    row = line();
    add(row, ["This", "That"]);
    row.append(" ain't ");
    add(row, ["that", "this"]);
    row.append(" or is it ?");
    row = line();
    row.append("What you ");
    add(row, ["can't quite", "won't yet", "may never"]);
    row.append(" say.");
  }

  private commitTextOnLeave(input: HTMLInputElement, apply: (value: string) => void | Promise<void>) {
    const commit = () => void apply(input.value);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
  }

  private updatePreview() {
    const host = this.containerEl.querySelector(".morph-block");
    if (host && host.instanceOf(HTMLElement)) this.fillPreview(host);
  }
}

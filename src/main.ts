import {
  App,
  Editor,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { morphLivePreview } from "./livepreview";
import { morphAutoClose } from "./autoclose";
import { applyOuterMarkup, hydrateMorphMarkdown, markupFromAncestors, peelOuterMarkup } from "./markdown";
import {
  createMorph,
  Defaults,
  FILTER_ID,
  MorphHandle,
  parseBlock,
  parseSpec,
  rewriteMorphSeparators,
  Style,
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
  titleSeparator: string;
  rewriteOnSeparatorChange: boolean;
  autoCloseMorph: boolean;
}

const DEFAULTS: MorphSettings = {
  hold: 2,
  fade: 1,
  style: "morph",
  separator: ";",
  morphTitles: true,
  titleInline: true,
  titleHeader: true,
  titleExplorer: true,
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
    Object.assign(this.settings, await this.loadData());
    if (!(STYLES as readonly string[]).includes(this.settings.style)) this.settings.style = "morph";
    this.appliedSeparator = this.settings.separator;
    this.appliedTitleSeparator = this.settings.titleSeparator;
    this.installFilter();

    // Reading view: inline {~ a | b ~}
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (el.closest(".morph-text, .morph-word")) return;
      this.renderMorphsInElement(el, ctx);
    }, 10000);

    this.registerMarkdownCodeBlockProcessor("morph", (src, el, ctx) => {
      const spec = parseBlock(src, this.settings.separator);
      if (!spec.items.length) return;
      const handle = createMorph(spec, this.settings);
      el.createDiv({ cls: "morph-block" }).appendChild(handle.el);
      const child = new MorphChild(handle.el, handle.destroy);
      ctx.addChild(child);
      void hydrateMorphMarkdown(handle, spec, this.app, ctx.sourcePath, child);
    });

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
      name: "Insert morph set (wraps selection)",
      editorCallback: (editor: Editor) => this.insertInline(editor),
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
    });

    this.addCommand({
      id: "convert-slash-pipe-list",
      name: "Convert slash or pipe list to morph set",
      editorCallback: (editor: Editor) => this.convertSlashPipeList(editor),
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "/" }],
    });

    this.addCommand({
      id: "insert-morph-block",
      name: "Insert morph block",
      editorCallback: (editor: Editor) => this.insertBlock(editor),
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
    const titlesTo = s.titleSeparator;

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
      const data = await this.app.vault.read(file);
      const next = rewriteMorphSeparators(data, from, to);
      if (next === data) continue;
      await this.app.vault.modify(file, next);
      changed++;
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

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private installFilter() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    svg.innerHTML =
      `<defs><filter id="${FILTER_ID}" x="-20%" y="-60%" width="140%" height="220%" color-interpolation-filters="sRGB">` +
      `<feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 255 -140"/>` +
      `</filter></defs>`;
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
      let spec = parseSpec(raw, this.settings.separator);
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
    const frag = document.createDocumentFragment();
    const handles: MorphHandle[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = parseSpec(m[1], sep);
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
  // File names cannot contain "|" (or "/" and ":"), so titles use their own separator
  // (default ";") and per-word timing is limited to "@hold" — use hold= / fade= / style=
  // in the first segment for the rest.

  private setupTitles() {
    const schedule = (delay = 120) => {
      window.clearTimeout(this.titleTimer);
      this.titleTimer = window.setTimeout(() => this.scanTitles(), delay);
    };

    this.registerEvent(this.app.workspace.on("layout-change", () => schedule()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => schedule()));
    this.registerEvent(this.app.workspace.on("file-open", () => schedule()));
    this.registerEvent(this.app.vault.on("rename", () => schedule()));
    this.app.workspace.onLayoutReady(() => schedule());

    // Obsidian re-renders titles on its own schedule; this cheap rescan is the safety net.
    // (The file explorer can be huge, so it is handled by the observer below instead.)
    this.registerInterval(window.setInterval(() => this.scanTitles(false), 2000));

    // File explorer: rows appear when folders expand, sort or filter, so watch for them.
    const explorerObserver = new MutationObserver((records) => {
      const relevant = records.some((r) => {
        const el = r.target instanceof Element ? r.target : r.target.parentElement;
        return !!el && !el.closest(".morph-text") && !!el.closest('[data-type="file-explorer"]');
      });
      if (relevant) schedule(100);
    });
    this.app.workspace.onLayoutReady(() =>
      explorerObserver.observe(this.app.workspace.containerEl, { childList: true, subtree: true })
    );
    this.register(() => explorerObserver.disconnect());

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

    const built = this.buildFragment(raw, this.settings.titleSeparator || ";");
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

  private insertInline(editor: Editor) {
    const sep = this.settings.separator.trim() || ";";
    const sel = editor.getSelection();
    if (sel) {
      const parts = (sel.includes("\n") ? sel.split("\n") : sel.includes(sep) ? sel.split(sep) : sel.split(","))
        .map((s) => s.trim())
        .filter(Boolean);
      editor.replaceSelection(`{~ ${parts.join(` ${sep} `)} ~}`);
      return;
    }
    const from = editor.getCursor("from");
    editor.replaceSelection(`{~  ${sep} ~}`);
    editor.setCursor({ line: from.line, ch: from.ch + 3 });
  }

  private convertSlashPipeList(editor: Editor) {
    const sep = this.settings.separator || ";";
    const wrapLine = (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("{~")) return raw;
      const parts = this.listParts(trimmed);
      if (!parts) return raw;
      const lead = raw.match(/^\s*/)?.[0] ?? "";
      const trail = raw.match(/\s*$/)?.[0] ?? "";
      return `${lead}{~ ${parts.join(sep)} ~}${trail}`;
    };

    const sel = editor.getSelection();
    if (sel) {
      const next = sel.includes("\n") ? sel.split("\n").map(wrapLine).join("\n") : wrapLine(sel);
      if (next !== sel) editor.replaceSelection(next);
      return;
    }

    const cur = editor.getCursor();
    const line = editor.getLine(cur.line);
    if (this.inMorphSpan(line, cur.ch)) return;
    const next = wrapLine(line);
    if (next === line) return;
    editor.replaceRange(next, { line: cur.line, ch: 0 }, { line: cur.line, ch: line.length });
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
    const items = parts.filter(Boolean);
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

  private insertBlock(editor: Editor) {
    const sel = editor.getSelection();
    const words = sel ? sel.split("\n").map((s) => s.trim()).filter(Boolean) : ["", ""];
    const from = editor.getCursor("from");
    editor.replaceSelection("```morph\nhold=2 fade=1\n" + words.join("\n") + "\n```");
    if (!sel) editor.setCursor({ line: from.line + 2, ch: 0 });
  }
}

class MorphSettingTab extends PluginSettingTab {
  private previews: MorphHandle[] = [];

  constructor(app: App, private plugin: MorphTextPlugin) {
    super(app, plugin);
  }

  hide() {
    const active = this.containerEl.ownerDocument.activeElement;
    if (active instanceof HTMLElement && this.containerEl.contains(active)) active.blur();
    this.previews.forEach((h) => h.destroy());
    this.previews = [];
  }

  display() {
    const { containerEl } = this;
    this.hide();
    containerEl.empty();

    new Setting(containerEl)
      .setName("Metamorphosis style")
      .setDesc("Default metamorphosis animation.")
      .addDropdown((dd) => {
        for (const s of STYLES) dd.addOption(s, STYLE_LABELS[s]);
        dd.setValue(this.plugin.settings.style).onChange(async (v) => {
          this.plugin.settings.style = v as Style;
          await this.plugin.saveSettings();
          this.updatePreview();
        });
      });

    new Setting(containerEl)
      .setName("Metamorphosis duration")
      .setDesc("Interval in seconds during which metamorphosis takes place.")
      .addSlider((s) =>
        s
          .setLimits(0.1, 5, 0.1)
          .setValue(this.plugin.settings.fade)
          .onChange(async (v) => {
            this.plugin.settings.fade = v;
            await this.plugin.saveSettings();
            this.updatePreview();
          })
      );

    new Setting(containerEl)
      .setName("No metamorphosis duration")
      .setDesc("Interval in seconds during which morpheme stays visible before metamorphosis takes place.")
      .addSlider((s) =>
        s
          .setLimits(0.2, 10, 0.1)
          .setValue(this.plugin.settings.hold)
          .onChange(async (v) => {
            this.plugin.settings.hold = v;
            await this.plugin.saveSettings();
            this.updatePreview();
          })
      );

    new Setting(containerEl)
      .setName("Morphemes separator")
      .setDesc("Symbol to separate morphemes.")
      .addText((t) => {
        t.setValue(this.plugin.settings.separator).setPlaceholder(";");
        this.commitTextOnLeave(t.inputEl, async (v) => {
          if (this.plugin.settings.separator === v) return;
          this.plugin.settings.separator = v;
          await this.plugin.saveSettings();
          await this.plugin.flushSeparatorRewrite();
        });
      });

    new Setting(containerEl)
      .setName("Rewrite metamorphemes on separator change")
      .setDesc("Update separators inside existing metamorphemes across the vault.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.rewriteOnSeparatorChange).onChange(async (v) => {
          this.plugin.settings.rewriteOnSeparatorChange = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-close {~  ~}")
      .setDesc("When enabled, typing ~ inside {} inserts {~  ~} with the cursor in the middle. Requires Editor → Auto pair brackets setting being enabled.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoCloseMorph).onChange(async (v) => {
          this.plugin.settings.autoCloseMorph = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Titles").setHeading();

    new Setting(containerEl)
      .setName("Morph note titles")
      .setDesc("Master switch for morphing note titles.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.morphTitles).onChange(async (v) => {
          this.plugin.settings.morphTitles = v;
          await this.plugin.saveSettings();
          this.plugin.refreshTitles();
        })
      );

    new Setting(containerEl)
      .setName("Editor")
      .setDesc("The title at the top of the note editor.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.titleInline).onChange(async (v) => {
          this.plugin.settings.titleInline = v;
          await this.plugin.saveSettings();
          this.plugin.refreshTitles();
        })
      );

    new Setting(containerEl)
      .setName("Tab & Header")
      .setDesc("The title shown in the tab and in the note header.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.titleHeader).onChange(async (v) => {
          this.plugin.settings.titleHeader = v;
          await this.plugin.saveSettings();
          this.plugin.refreshTitles();
        })
      );

    new Setting(containerEl)
      .setName("File explorer")
      .setDesc("File and folder names in the sidebar.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.titleExplorer).onChange(async (v) => {
          this.plugin.settings.titleExplorer = v;
          await this.plugin.saveSettings();
          this.plugin.refreshTitles();
        })
      );

    new Setting(containerEl)
      .setName("Morphemes separator")
      .setDesc('Used inside file names, where some symbols are not allowed.')
      .addText((t) => {
        t.setValue(this.plugin.settings.titleSeparator).setPlaceholder(";");
        this.commitTextOnLeave(t.inputEl, async (v) => {
          if (this.plugin.settings.titleSeparator === v) return;
          this.plugin.settings.titleSeparator = v;
          await this.plugin.saveSettings();
          this.plugin.refreshTitles();
          await this.plugin.flushSeparatorRewrite();
        });
      });

    new Setting(containerEl).setName("Preview").setHeading();
    this.fillPreview(containerEl.createDiv({ cls: "morph-block" }));
  }

  private fillPreview(host: HTMLElement) {
    this.previews.forEach((h) => h.destroy());
    this.previews = [];
    host.empty();
    const d = this.plugin.settings;
    const add = (parent: HTMLElement, words: string[]) => {
      const handle = createMorph({ items: words.map((text) => ({ text })), hold: d.hold }, d);
      this.previews.push(handle);
      parent.appendChild(handle.el);
    };
    add(host, ["Say", "Mean"]);
    host.append(" what you ");
    add(host, ["mean", "say"]);
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
    if (host instanceof HTMLElement) this.fillPreview(host);
  }
}

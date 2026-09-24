import {
  App,
  Editor,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { morphLivePreview } from "./livepreview";
import { createMorph, Defaults, FILTER_ID, MorphHandle, parseBlock, parseSpec, Style, STYLE_LABELS, STYLES } from "./morph";

interface MorphSettings extends Defaults {
  /** master switch for morphing note titles */
  morphTitles: boolean;
  /** morph the big inline title at the top of a note */
  titleInline: boolean;
  /** morph the tab title and the view-header title */
  titleHeader: boolean;
  /** morph file and folder names in the file explorer */
  titleExplorer: boolean;
  /** separator used inside file names ("|" is not allowed in file names) */
  titleSeparator: string;
}

const DEFAULTS: MorphSettings = {
  hold: 2,
  fade: 1,
  style: "morph",
  separator: " | ",
  morphTitles: true,
  titleInline: true,
  titleHeader: true,
  titleExplorer: true,
  titleSeparator: ";",
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

  async onload() {
    Object.assign(this.settings, await this.loadData());
    if (!(STYLES as readonly string[]).includes(this.settings.style)) this.settings.style = "morph";
    this.installFilter();

    // Reading view: inline {~ a | b ~}
    this.registerMarkdownPostProcessor((el, ctx) => {
      const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) {
        const n = walker.currentNode as Text;
        if (n.nodeValue?.includes("{~") && !n.parentElement?.closest("code, pre")) nodes.push(n);
      }
      nodes.forEach((n) => this.renderInText(n, ctx));
    });

    // ```morph blocks (Reading + Live Preview)
    this.registerMarkdownCodeBlockProcessor("morph", (src, el, ctx) => {
      const spec = parseBlock(src, this.settings.separator);
      if (!spec.items.length) return;
      const { el: m, destroy } = createMorph(spec, this.settings);
      el.createDiv({ cls: "morph-block" }).appendChild(m);
      ctx.addChild(new MorphChild(el, destroy));
    });

    // Live Preview: inline widgets
    this.registerEditorExtension(morphLivePreview(this.settings));

    this.addCommand({
      id: "insert-morph-set",
      name: "Insert morph set (wraps selection)",
      editorCallback: (editor: Editor) => this.insertInline(editor),
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
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

  private renderInText(node: Text, ctx: MarkdownPostProcessorContext) {
    const built = this.buildFragment(node.nodeValue ?? "", this.settings.separator);
    if (!built) return;
    built.handles.forEach((h) => ctx.addChild(new MorphChild(h.el, h.destroy)));
    node.replaceWith(built.frag);
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
    const sep = this.settings.separator.trim() || "|";
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

  private insertBlock(editor: Editor) {
    const sel = editor.getSelection();
    const words = sel ? sel.split("\n").map((s) => s.trim()).filter(Boolean) : ["", ""];
    const from = editor.getCursor("from");
    editor.replaceSelection("```morph\nhold=2 fade=1\n" + words.join("\n") + "\n```");
    if (!sel) editor.setCursor({ line: from.line + 2, ch: 0 });
  }
}

class MorphSettingTab extends PluginSettingTab {
  private preview?: MorphHandle;

  constructor(app: App, private plugin: MorphTextPlugin) {
    super(app, plugin);
  }

  hide() {
    this.preview?.destroy();
    this.preview = undefined;
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
      .addText((t) =>
        t
          .setValue(this.plugin.settings.separator)
          .setPlaceholder("Enter separator...")
          .onChange(async (v) => {
            this.plugin.settings.separator = v;
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
      .addText((t) =>
        t
          .setValue(this.plugin.settings.titleSeparator)
          .setPlaceholder(";")
          .onChange(async (v) => {
            this.plugin.settings.titleSeparator = v;
            await this.plugin.saveSettings();
            this.plugin.refreshTitles();
          })
      );

    new Setting(containerEl).setName("Preview").setHeading();
    const box = containerEl.createDiv({ cls: "morph-block" });
    this.preview = createMorph(
      { items: [{ text: "Say" }, { text: "Mean" }], hold: this.plugin.settings.hold },
      this.plugin.settings
    );
    box.appendChild(this.preview.el);
  }

  private updatePreview() {
    if (!this.preview) return;
    const parent = this.preview.el.parentElement;
    if (parent) {
      this.preview.destroy();
      parent.empty();
      this.preview = createMorph(
        { items: [{ text: "Say" }, { text: "Mean" }], hold: this.plugin.settings.hold },
        this.plugin.settings
      );
      parent.appendChild(this.preview.el);
    }
  }
}

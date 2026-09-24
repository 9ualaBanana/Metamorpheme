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

const DEFAULTS: Defaults = { hold: 2, fade: 1, style: "morph", separator: " | " };

class MorphChild extends MarkdownRenderChild {
  constructor(el: HTMLElement, private cleanup: () => void) {
    super(el);
  }
  onunload() {
    this.cleanup();
  }
}

export default class MorphTextPlugin extends Plugin {
  settings: Defaults = { ...DEFAULTS };
  private svg?: SVGSVGElement;

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
  }

  onunload() {
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

  private renderInText(node: Text, ctx: MarkdownPostProcessorContext) {
    const text = node.nodeValue ?? "";
    const re = /\{~(.+?)~\}/g;
    const frag = document.createDocumentFragment();
    let last = 0;
    let any = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = parseSpec(m[1], this.settings.separator);
      if (!spec.items.length) continue;
      any = true;
      frag.append(text.slice(last, m.index));
      const { el, destroy } = createMorph(spec, this.settings);
      frag.append(el);
      ctx.addChild(new MorphChild(el, destroy));
      last = m.index + m[0].length;
    }
    if (!any) return;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }

  private insertInline(editor: Editor) {
    const sel = editor.getSelection();
    if (sel) {
      const parts = (sel.includes("\n") ? sel.split("\n") : sel.includes(this.settings.separator) ? sel.split(this.settings.separator) : sel.split(","))
        .map((s) => s.trim())
        .filter(Boolean);
      editor.replaceSelection(`{~ ${parts.join(` ${this.settings.separator} `)} ~}`);
      return;
    }
    const from = editor.getCursor("from");
    editor.replaceSelection(`{~  ${this.settings.separator} ~}`);
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

    containerEl.createEl("h2", { text: "Morph Text Settings" });

    new Setting(containerEl)
      .setName("Fade style")
      .setDesc("Default transition between words. Override per set with style=slide (or any style below).")
      .addDropdown((dd) => {
        for (const s of STYLES) dd.addOption(s, STYLE_LABELS[s]);
        dd.setValue(this.plugin.settings.style).onChange(async (v) => {
          this.plugin.settings.style = v as Style;
          await this.plugin.saveSettings();
          this.updatePreview();
        });
      });

    new Setting(containerEl)
      .setName("Default hold time")
      .setDesc("Seconds a word stays fully visible before the next one starts fading in.")
      .addSlider((s) =>
        s
          .setLimits(0.2, 10, 0.1)
          .setValue(this.plugin.settings.hold)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.hold = v;
            await this.plugin.saveSettings();
            this.updatePreview();
          })
      );

    new Setting(containerEl)
      .setName("Default fade time")
      .setDesc("Seconds the morph into the next word takes.")
      .addSlider((s) =>
        s
          .setLimits(0.1, 5, 0.1)
          .setValue(this.plugin.settings.fade)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.fade = v;
            await this.plugin.saveSettings();
            this.updatePreview();
          })
      );
      
    new Setting(containerEl)
      .setName("Separator")
      .setDesc("Symbol to separate words.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.separator)
          .setPlaceholder("Enter separator...")
          .onChange(async (v) => {
            this.plugin.settings.separator = v;
            await this.plugin.saveSettings();
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

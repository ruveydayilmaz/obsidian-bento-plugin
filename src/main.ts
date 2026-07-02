import {
  App,
  Component,
  debounce,
  FuzzySuggestModal,
  MarkdownPostProcessorContext,
  MarkdownRenderer,
  MarkdownView,
  normalizePath,
  Plugin,
  PluginManifest,
  TFile,
} from "obsidian";

type BentoItemType = "text" | "image" | "markdown" | "page" | "countdown";

interface BentoItem {
  id: string;
  type: BentoItemType;
  title?: string;
  url?: string;
  content?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state?: {
    remaining: number;
    running: boolean;
    phase: "work" | "break";
  };
  transparent?: boolean;
  progressMode?: "direct" | "formula";
  progressCurrent?: number;
  progressTarget?: number;
}

interface BentoState {
  layoutVersion?: number;
  items: BentoItem[];
  dirty?: boolean;
}

type LegacyBentoItem = BentoItem & {
  col?: number;
  row?: number;
  w?: number;
  h?: number;
};

type LegacyBentoState = BentoState & {
  cols?: number;
  rowHeight?: number;
};

interface Destroyable {
  cleanup(): void;
}

class PageSelectModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onChoose: (file: TFile) => void
  ) {
    super(app);
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

class ImageSelectModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onChoose: (file: TFile) => void
  ) {
    super(app);
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(
      f => /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f.path)
    );
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

function onClickOutside(
  targets: HTMLElement[],
  callback: () => void,
): () => void {
  const handler = (e: PointerEvent) => {
    const node = e.target as Node;
    if (targets.some((t) => t.contains(node))) return;
    callback();

    activeDocument.removeEventListener("pointerdown", handler, { capture: true });
  };
  activeDocument.addEventListener("pointerdown", handler, { capture: true });

  return () =>
    activeDocument.removeEventListener("pointerdown", handler, { capture: true });
}

function isDestroyable(
  widget: BentoWidget,
): widget is BentoWidget & Destroyable {
  return (
    typeof (widget as BentoWidget & Partial<Destroyable>).cleanup === "function"
  );
}

let widgetRegistry = new WeakMap<HTMLElement, BentoWidget>();

const BENTO_SNAP_THRESHOLD = 8;

abstract class BentoWidget implements Destroyable {
  protected renderComponent = new Component();

  constructor(
    protected container: HTMLElement,
    protected item: BentoItem,
    protected state: BentoState,
    protected ctx: MarkdownPostProcessorContext,
    protected plugin: BentoPlugin,
  ) { }

  abstract render(): Promise<void>;

  cleanup(): void {
    this.renderComponent.unload();
  }
}

class TextWidget extends BentoWidget {
  async render() {
    this.container.classList.add("bento-text");
    this.container.innerText = this.item.content ?? "Empty text";
  }
}

class MarkdownWidget extends BentoWidget {
  async render() {
    this.container.classList.add("bento-markdown");
    const rendered = this.container.createDiv("bento-safe-markdown");
    await MarkdownRenderer.render(
      this.plugin.app,
      this.item.content ?? "*Empty markdown*",
      rendered,
      this.ctx.sourcePath,
      this.renderComponent,
    );
    rendered
      .querySelectorAll(".block-language-bento")
      .forEach((el) => el.remove());
  }
}

class ImageWidget extends BentoWidget {
  async render() {
    this.container.classList.add("bento-image");

    if (this.item.content) {
      const img = this.container.createEl("img", { cls: "image-widget" });
      img.src = this.plugin.resolveImageSrc(this.item.content);
      img.setAttr("title", this.item.content);
      img.onerror = () => {
        this.container.empty();
        this.container.createEl("div", {
          text: "Image not found, re-upload or choose from vault",
        });
      };
    } else {
      this.container.createEl("div", { text: "Double-click to add image" });
    }
  }
}

class PageWidget extends BentoWidget implements Destroyable {
  watchedPath: string | null = null;

  private debouncedRerender = debounce(async () => {
    if (!activeDocument.contains(this.container)) return;
    this.container.empty();
    await this.renderContent();
  }, 300);

  async render() {
    this.container.classList.add("bento-page");
    if (!this.item.content) {
      this.container.createEl("div", {
        text: "Double-click to select page",
      });
      return;
    }
    this.watchedPath = this.item.content;
    this.plugin.pageWidgets.add(this);
    await this.renderContent();
  }

  onFileModified(file: TFile) {
    if (file.path !== this.watchedPath) return;
    this.debouncedRerender();
  }

  cleanup() {
    this.plugin.pageWidgets.delete(this);
    this.watchedPath = null;
    (
      this.debouncedRerender as ReturnType<typeof debounce> & {
        cancel?: () => void;
      }
    ).cancel?.();
    super.cleanup();
  }

  private async renderContent() {
    if (!this.watchedPath) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(
      this.watchedPath,
    );
    if (!(file instanceof TFile)) {
      this.container.createEl("div", { text: "Page not found" });
      return;
    }
    const content = await this.plugin.app.vault.cachedRead(file);
    const rendered = this.container.createDiv(
      "bento-markdown-content bento-safe-markdown",
    );

    await MarkdownRenderer.render(
      this.plugin.app,
      content,
      rendered,
      file.path,
      this.renderComponent,
    );
    rendered
      .querySelectorAll(".block-language-bento")
      .forEach((el) => el.remove());
    this.wireCheckboxes(rendered, file);
  }

  private wireCheckboxes(rendered: HTMLElement, file: TFile) {
    const checkboxes = rendered.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    checkboxes.forEach((checkbox, index) => {
      const fresh = checkbox.cloneNode(true) as HTMLInputElement;
      checkbox.replaceWith(fresh);
      fresh.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        void this.plugin.app.vault
          .process(file, (current) => {
            const lines = current.split("\n");
            let found = 0;
            for (let i = 0; i < lines.length; i++) {
              const unchecked = /^(\s*[-*+]|\s*\d+[.)]) \[ \]/.test(lines[i]);
              const checked = /^(\s*[-*+]|\s*\d+[.)]) \[x\]/i.test(lines[i]);
              if (unchecked || checked) {
                if (found === index) {
                  lines[i] = unchecked
                    ? lines[i].replace("[ ]", "[x]")
                    : lines[i].replace(/\[x\]/i, "[ ]");
                  break;
                }
                found++;
              }
            }
            return lines.join("\n");
          })
          .catch((err) => console.error("Bento: failed to update checkbox", err));
      });
    });
  }
}

class CountdownWidget extends BentoWidget implements Destroyable {
  private intervalId: number | null = null;

  async render() {
    this.cleanup();
    this.container.classList.add("bento-countdown");
    const targetDate = this.item.content ? new Date(this.item.content) : null;
    if (!targetDate) {
      this.container.createEl("div", { text: "No date set" });
      return;
    }
    const wrapper = this.container.createEl("div", {
      cls: "countdown-wrapper",
    });
    const daysBox = wrapper.createEl("div", { cls: "countdown-box" });
    const hoursBox = wrapper.createEl("div", { cls: "countdown-box" });
    const daysDigits = daysBox.createEl("div", { cls: "countdown-digits" });
    const daysLabel = daysBox.createEl("div", { cls: "countdown-label" });
    const hoursDigits = hoursBox.createEl("div", { cls: "countdown-digits" });
    const hoursLabel = hoursBox.createEl("div", { cls: "countdown-label" });

    const update = () => {
      const diff = targetDate.getTime() - Date.now();
      if (diff <= 0) {
        daysDigits.setText("00");
        hoursDigits.setText("00");
        this.cleanup();
        return;
      }
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
      daysDigits.setText(days.toString().padStart(2, "0"));
      hoursDigits.setText(hours.toString().padStart(2, "0"));
      daysLabel.setText(days === 1 ? "Day" : "Days");
      hoursLabel.setText(hours === 1 ? "Hour" : "Hours");
    };

    update();
    this.intervalId = window.setInterval(update, 1000);
  }

  cleanup() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

class WidgetFactory {
  constructor(private plugin: BentoPlugin) { }

  createWidget(
    type: BentoItemType,
    container: HTMLElement,
    item: BentoItem,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
  ): BentoWidget {
    switch (type) {
      case "text":
        return new TextWidget(container, item, state, ctx, this.plugin);
      case "markdown":
        return new MarkdownWidget(container, item, state, ctx, this.plugin);
      case "image":
        return new ImageWidget(container, item, state, ctx, this.plugin);
      case "page":
        return new PageWidget(container, item, state, ctx, this.plugin);
      case "countdown":
        return new CountdownWidget(container, item, state, ctx, this.plugin);
      default:
        throw new Error(`Unknown widget type: ${type}`);
    }
  }
}

export default class BentoPlugin extends Plugin {
  private widgetFactory: WidgetFactory;
  public pageWidgets = new Set<PageWidget>();

  private isRendering = false;

  public debouncedUpdateGridHeight!: (
    grid: HTMLElement,
    items: BentoItem[],
  ) => void;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
    this.widgetFactory = new WidgetFactory(this);
  }

  public debouncedSave = debounce(
    (
      ctx: MarkdownPostProcessorContext,
      state: BentoState,
      container: HTMLElement,
    ) => this.saveState(ctx, state, container),
    500,
  );

  saveState(
    ctx: MarkdownPostProcessorContext,
    state: BentoState,
    container: HTMLElement,
  ) {
    this.saveBackToNote(ctx, state, container);
    state.dirty = false;
  }

  async onload() {
    this.debouncedUpdateGridHeight = debounce(
      (grid: HTMLElement, items: BentoItem[]) =>
        this.updateGridHeight(grid, items),
      100,
    );

    this.addRibbonIcon("pane-layout", "Add a bento grid", () => {
      this.insertGrid();
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;

        Array.from(this.pageWidgets).forEach((widget) =>
          widget.onFileModified(file)
        );
      }),
    );

    this.registerMarkdownCodeBlockProcessor("bento", (src, el, ctx) => {
      let state: BentoState;
      try {
        state = JSON.parse(src) as BentoState;
      } catch {
        state = { items: [] };
      }
      this.migrateState(state);
      if (el.dataset.bentoInitialized === "true") return;
      el.dataset.bentoInitialized = "true";
      const bentoOuter = el.createDiv("bento-outer-div");
      bentoOuter.dataset.bentoRoot = "true";
      this.createToolbar(bentoOuter, state, ctx);
      const grid = bentoOuter.createDiv("bento-grid");
      this.renderGrid(grid, state, ctx);
      this.updateGridHeight(grid, state.items);
    });
  }

  onunload() {
    Array.from(this.pageWidgets).forEach((widget) => widget.cleanup());
    this.pageWidgets.clear();

    widgetRegistry = new WeakMap();
    this.debouncedSave.cancel?.();
  }

  private insertGrid() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const editor = view.editor;

    editor.replaceSelection(
      "```bento\n```\n"
    );
  }

  private createToolbar(
    container: HTMLElement,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
  ) {
    const toolbar = container.createDiv("bento-toolbar");
    const addBtn = toolbar.createEl("button", { text: "Add widget" });
    addBtn.classList.add("bento-add-btn");

    const dropdown = toolbar.createDiv("bento-dropdown hidden");
    let removeOutsideListener: (() => void) | null = null;

    this.registerDomEvent(
      addBtn,
      "click",
      (e) => {
        e.stopPropagation();
        const isHidden = dropdown.classList.contains("hidden");
        dropdown.classList.toggle("hidden", !isHidden);
        if (isHidden) {
          removeOutsideListener = onClickOutside([dropdown, addBtn], () => {
            dropdown.classList.add("hidden");
            removeOutsideListener = null;
          });
        } else {
          removeOutsideListener?.();
          removeOutsideListener = null;
        }
      });

    const widgetTypes: BentoItemType[] = [
      "text",
      "markdown",
      "image",
      "page",
      "countdown",
    ];
    widgetTypes.forEach((type) => {
      const opt = dropdown.createDiv("bento-dropdown-item");
      opt.setText(type.charAt(0).toUpperCase() + type.slice(1));
      this.registerDomEvent(
        opt,
        "click",
        async (e) => {
          e.stopPropagation();
          dropdown.classList.add("hidden");
          removeOutsideListener?.();
          removeOutsideListener = null;
          this.addNewItem(state, type);
          state.dirty = true;
          const newItem = state.items[state.items.length - 1];
          const grid = container.querySelector<HTMLElement>(".bento-grid");
          if (!grid) return;
          await this.renderItem(grid, state, ctx, newItem);
          this.updateGridHeight(grid, state.items);
          this.debouncedSave(ctx, state, container);
        });
    });
  }

  private migrateState(state: BentoState) {
    if (state.layoutVersion === 2) return;
    const colWidth = 200;
    const rowHeight = 120;
    const gap = 12;
    (state.items as LegacyBentoItem[]).forEach((item) => {
      if (
        item.col !== undefined &&
        item.row !== undefined &&
        item.h !== undefined &&
        item.w !== undefined
      ) {
        item.x = (item.col - 1) * (colWidth + gap);
        item.y = (item.row - 1) * (rowHeight + gap);
        item.width = item.w * colWidth + (item.w - 1) * gap;
        item.height = item.h * rowHeight + (item.h - 1) * gap;
        delete item.col;
        delete item.row;
        delete item.w;
        delete item.h;
      }
    });
    const legacy = state as LegacyBentoState;
    delete legacy.cols;
    delete legacy.rowHeight;
    state.layoutVersion = 2;
  }

  private addNewItem(state: BentoState, type: BentoItemType) {
    const y = state.items.reduce(
      (max, it) => Math.max(max, it.y + it.height),
      0,
    );
    state.items.push({
      id: String(Date.now()),
      type,
      title: type.charAt(0).toUpperCase() + type.slice(1),
      content: "",
      x: 0,
      y: y + 12,
      width: 200,
      height: 120,
    });
  }

  private renderGrid(
    container: HTMLElement,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
  ) {
    container.empty();
    for (const item of state.items) {
      void this.renderItem(container, state, ctx, item).catch((err) =>
        console.error("Bento: failed to render item", err),
      );
    }
  }

  public updateGridHeight(grid: HTMLElement, items: BentoItem[]) {
    const requiredHeight = items.reduce(
      (max, item) => Math.max(max, item.y + item.height),
      0,
    );
    grid.style.setProperty("--bento-grid-height", `${requiredHeight}px`);
  }

  private async renderItem(
    container: HTMLElement,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    item: BentoItem,
  ) {
    const itemStyle =
      item.type === "image"
        ? "bento-item noselect"
        : item.transparent
          ? "bento-item noselect default-padding"
          : "bento-item noselect colored-background default-padding";

    const card = container.createDiv(itemStyle);
    card.setAttr("data-id", item.id);
    card.style.setProperty("--bento-item-x", `${item.x}px`);
    card.style.setProperty("--bento-item-y", `${item.y}px`);
    card.style.setProperty("--bento-item-width", `${item.width}px`);
    card.style.setProperty("--bento-item-height", `${item.height}px`);

    if (item.type !== "image") { // DEGISTIRRR
      this.createItemHeader(card, item, state, ctx, container);
    }

    const widgetWrap = card.createDiv("bento-widget-wrap");
    try {
      this.isRendering = true;
      const widget = this.widgetFactory.createWidget(
        item.type,
        widgetWrap,
        item,
        state,
        ctx,
      );
      await widget.render();
      widgetRegistry.set(widgetWrap, widget);
    } catch (e) {
      widgetWrap.createEl("div", { text: `Widget failed to load: ${e}` });
    } finally {
      this.isRendering = false;
    }

    this.makeDraggable(card, item, state, container, ctx);
    this.makeResizable(card, item, state, container, ctx);
    this.addEditHandlers(widgetWrap, item, state, ctx, container);

    card.tabIndex = 0;
    this.registerDomEvent(
      card,
      "keydown",
      (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
          e.preventDefault();
          e.stopPropagation();
          this.duplicateItem(container, state, ctx, item);
        }
      });
  }

  private clampToGridBounds(
    x: number,
    y: number,
    width: number,
    gridEl: HTMLElement,
  ): { x: number; y: number } {
    const maxX = Math.max(0, gridEl.clientWidth - width);
    return {
      x: Math.min(Math.max(x, 0), maxX),
      y: Math.max(y, 0),
    };
  }

  private findFreePosition(
    candidate: BentoItem,
    state: BentoState,
    gridEl: HTMLElement,
  ): { x: number; y: number } {
    const STEP = 12;
    const maxX = Math.max(0, gridEl.clientWidth - candidate.width);

    let { x, y } = this.clampToGridBounds(
      candidate.x,
      candidate.y,
      candidate.width,
      gridEl,
    );

    const collides = (px: number, py: number) =>
      this.findCollisions({ ...candidate, x: px, y: py }, state.items).length > 0;

    const MAX_ATTEMPTS = 500;
    let attempts = 0;
    while (collides(x, y) && attempts < MAX_ATTEMPTS) {
      x += STEP;
      if (x > maxX) {
        x = 0;
        y += STEP;
      }
      attempts++;
    }

    if (attempts >= MAX_ATTEMPTS) {
      x = 0;
      y =
        state.items.reduce((max, it) => Math.max(max, it.y + it.height), 0) +
        STEP;
    }

    return { x, y };
  }

  private duplicateItem(
    container: HTMLElement,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    item: BentoItem,
  ) {
    const clone: BentoItem = structuredClone(item);
    clone.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const OFFSET = 12;
    clone.x = item.x + OFFSET;
    clone.y = item.y + OFFSET;

    const { x, y } = this.findFreePosition(clone, state, container);
    clone.x = x;
    clone.y = y;

    state.items.push(clone);
    state.dirty = true;

    void this.renderItem(container, state, ctx, clone)
      .then(() => {
        this.updateGridHeight(container, state.items);
        this.debouncedSave(ctx, state, container);
      })
      .catch((err) => console.error("Bento: failed to duplicate item", err));
  }

  private createItemHeader(
    card: HTMLElement,
    item: BentoItem,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    container: HTMLElement,
  ) {
    const headerDiv = card.createDiv("bento-item-header-div");
    const header = headerDiv.createDiv("bento-item-header");
    header.setText(item.title ?? "Untitled");

    const menuBtn = headerDiv.createDiv("bento-menu-btn");
    menuBtn.setText("⋮");

    const dropdown = headerDiv.createDiv("bento-dropdown hidden");
    let removeOutsideListener: (() => void) | null = null;

    const label = dropdown.createEl("label");
    const checkbox = label.createEl("input", { type: "checkbox" });
    checkbox.checked = item.transparent ?? false;
    label.appendText(" Transparent background");

    this.registerDomEvent(
      checkbox,
      "change",
      () => {
        item.transparent = checkbox.checked;
        card.classList.toggle("colored-background", !item.transparent);
        state.dirty = true;
        this.debouncedSave(ctx, state, container);
      });

    const dupBtn = dropdown.createEl("button", { text: "Duplicate card" });
    this.registerDomEvent(
      dupBtn,
      "click",
      (e) => {
        e.stopPropagation();
        dropdown.classList.add("hidden");
        removeOutsideListener?.();
        removeOutsideListener = null;
        this.duplicateItem(container, state, ctx, item);
      });

    const delBtn = dropdown.createEl("button", { text: "Delete card" });
    this.registerDomEvent(
      delBtn,
      "click",
      (e) => {
        e.stopPropagation();
        const wrap = card.querySelector<HTMLElement>(".bento-widget-wrap");
        if (wrap) {
          const hosted = widgetRegistry.get(wrap);
          if (hosted && isDestroyable(hosted)) hosted.cleanup();
          widgetRegistry.delete(wrap);
        }
        card.remove();
        state.items = state.items.filter((i) => i.id !== item.id);
        state.dirty = true;
        this.updateGridHeight(container, state.items);
        this.debouncedSave(ctx, state, container);
      });

    this.registerDomEvent(
      menuBtn,
      "pointerdown",
      (e) => {
        e.stopPropagation();
        const isHidden = dropdown.classList.contains("hidden");
        dropdown.classList.toggle("hidden", !isHidden);
        if (isHidden) {
          removeOutsideListener = onClickOutside([dropdown, menuBtn], () => {
            dropdown.classList.add("hidden");
            removeOutsideListener = null;
          });
        } else {
          removeOutsideListener?.();
          removeOutsideListener = null;
        }
      });

    this.registerDomEvent(
      header,
      "dblclick",
      (e) => {
        e.stopPropagation();
        const input = header.createEl("input");
        input.value = item.title ?? "";
        header.empty();
        header.appendChild(input);
        input.focus();
        input.select();

        const commit = () => {
          item.title = input.value.trim() || "Untitled";
          state.dirty = true;
          header.setText(item.title);
          this.debouncedSave(ctx, state, container);
        };

        this.registerDomEvent(input, "blur", commit);
        this.registerDomEvent(
          input,
          "keydown",
          (ke) => {
            if (ke.key === "Enter") input.blur();
            if (ke.key === "Escape") {
              input.removeEventListener("blur", commit);
              header.setText(item.title ?? "Untitled");
            }
          });
      });
  }

  private addEditHandlers(
    widgetWrap: HTMLElement,
    item: BentoItem,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    container: HTMLElement,
  ) {
    this.registerDomEvent(
      widgetWrap,
      "dblclick",
      (e) => {
        e.stopPropagation();
        const current = widgetRegistry.get(widgetWrap);
        if (current && isDestroyable(current)) current.cleanup();
        switch (item.type) {
          case "text":
          case "markdown":
            this.editText(widgetWrap, item, state, ctx, container);
            break;
          case "image":
            this.editImage(widgetWrap, item, state, ctx, container);
            break;
          case "page":
            this.editPage(widgetWrap, item, state, ctx, container);
            break;
          case "countdown":
            this.editCountdown(widgetWrap, item, state, ctx, container);
            break;
        }
      });
  }

  private editText(
    widgetWrap: HTMLElement,
    item: BentoItem,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    container: HTMLElement,
  ) {
    const textarea = widgetWrap.createEl("textarea");
    textarea.value = item.content ?? "";
    widgetWrap.empty();
    widgetWrap.appendChild(textarea);
    textarea.focus();

    const commit = async () => {
      item.content = textarea.value;
      state.dirty = true;
      await this.updateItem(container, state, ctx, item);
      this.debouncedSave(ctx, state, container);
    };

    this.registerDomEvent(textarea, "blur", commit);
    this.registerDomEvent(
      textarea,
      "keydown",
      (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") textarea.blur();
      });
  }

  private editImage(
    widgetWrap: HTMLElement,
    item: BentoItem,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    container: HTMLElement,
  ) {
    widgetWrap.empty();

    const selectBtn = widgetWrap.createEl(
      "button",
      { text: "Select image" }
    );

    const uploadBtn = widgetWrap.createEl(
      "button",
      { text: "Upload image" }
    );

    this.registerDomEvent(
      selectBtn,
      "click",
      () => {
        new ImageSelectModal(
          this.app,
          (file) => {
            item.content = file.path;
            state.dirty = true;

            void this.updateItem(
              container,
              state,
              ctx,
              item
            ).then(() => {
              this.debouncedSave(
                ctx,
                state,
                container
              );
            }).catch((err) => console.error("Bento: failed to update image item", err));
          }
        ).open();
      }
    );

    this.registerDomEvent(
      uploadBtn,
      "click",
      () => {
        void this.uploadImage(
          item,
          state,
          ctx,
          container
        ).catch((err) => console.error("Bento: failed to upload image", err));
      }
    );
  }
  private async uploadImage(
    item: BentoItem,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    container: HTMLElement,
  ) {
    // const targetFolder = "images";
    const input = createEl("input");
    input.type = "file";
    input.accept = "image/*";

    this.registerDomEvent(
      input,
      "change",
      async () => {
        if (!input.files?.length) return;
        const file = input.files[0];
        const arrayBuf = await file.arrayBuffer();

        const targetPath = await this.app.fileManager.getAvailablePathForAttachment(file.name); // targetFolder

        const tfile = await this.app.vault.createBinary(targetPath, arrayBuf);
        item.content = tfile.path;
        state.dirty = true;

        await this.updateItem(container, state, ctx, item);
        this.debouncedSave(ctx, state, container);
      });

    input.click();
  }

  private editPage(
    widgetWrap: HTMLElement,
    item: BentoItem,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    container: HTMLElement,
  ) {
    new PageSelectModal(
      this.app,
      (file) => {
        item.content = file.path;
        state.dirty = true;

        void this.updateItem(
          container,
          state,
          ctx,
          item
        ).then(() => {
          this.debouncedSave(
            ctx,
            state,
            container
          );
        }).catch((err) => console.error("Bento: failed to update page item", err));
      }
    ).open();
  }

  private editCountdown(
    widgetWrap: HTMLElement,
    item: BentoItem,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    container: HTMLElement,
  ) {
    widgetWrap.empty();
    const input = widgetWrap.createEl("input");
    input.type = "date";
    if (item.content) input.value = item.content.slice(0, 10);
    input.focus();

    const commit = async () => {
      if (!input.value) return;
      item.content = input.value;
      state.dirty = true;
      await this.updateItem(container, state, ctx, item);
      this.debouncedSave(ctx, state, container);
    };

    this.registerDomEvent(input, "blur", commit);
    this.registerDomEvent(
      input,
      "keydown",
      (e) => {
        if (e.key === "Enter") input.blur();
      });
  }

  public async updateItem(
    container: HTMLElement,
    state: BentoState,
    ctx: MarkdownPostProcessorContext,
    item: BentoItem,
  ) {
    const itemEl = container.querySelector<HTMLElement>(
      `[data-id='${item.id}']`,
    );
    if (!itemEl) return;

    const widgetWrap = itemEl.querySelector<HTMLElement>(".bento-widget-wrap");
    if (widgetWrap) {
      const old = widgetRegistry.get(widgetWrap);
      if (old && isDestroyable(old)) old.cleanup();
      widgetRegistry.delete(widgetWrap);

      widgetWrap.empty();
      try {
        this.isRendering = true;
        const widget = this.widgetFactory.createWidget(
          item.type,
          widgetWrap,
          item,
          state,
          ctx,
        );
        await widget.render();
        widgetRegistry.set(widgetWrap, widget);
      } finally {
        this.isRendering = false;
      }
      this.addEditHandlers(widgetWrap, item, state, ctx, container);
    }

    const header = itemEl.querySelector<HTMLElement>(".bento-item-header");
    if (header) header.setText(item.title ?? "Untitled");
  }

  public resolveImageSrc(pathOrUrl: string): string {
    if (!pathOrUrl || /^(https?:|data:|blob:|file:)/i.test(pathOrUrl)) {
      return pathOrUrl;
    }
    const file = this.app.vault.getFileByPath(normalizePath(pathOrUrl));
    if (file) {
      return this.app.vault.getResourcePath(file);
    }
    return pathOrUrl;
  }

  private makeDraggable(
    el: HTMLElement,
    item: BentoItem,
    state: BentoState,
    container: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ) {
    const DRAG_THRESHOLD = 5;
    let startX = 0,
      startY = 0,
      startItemX = 0,
      startItemY = 0;
    let dragging = false;
    let isColliding = false;

    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).classList.contains("resize-handle")) return;
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "LABEL"].includes(tag))
        return;
      startX = e.clientX;
      startY = e.clientY;
      startItemX = item.x;
      startItemY = item.y;
      dragging = false;
      this.registerDomEvent(window, "pointermove", onPointerMove);
      this.registerDomEvent(window, "pointerup", onPointerUp);
    };

    const onPointerMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
          return;
        dragging = true;
        el.classList.add("dragging");

        if (!el.hasPointerCapture(e.pointerId)) {
          el.setPointerCapture(e.pointerId);
        }
      }
      const maxX = Math.max(0, container.clientWidth - item.width);
      item.x = Math.min(
        Math.max(Math.round((startItemX + dx) / 5) * 5, 0),
        maxX,
      );
      item.y = Math.round((startItemY + dy) / 5) * 5;
      el.style.setProperty("--bento-item-x", `${item.x}px`);
      el.style.setProperty("--bento-item-y", `${item.y}px`);
      isColliding = this.findCollisions(item, state.items).length > 0;
      el.classList.toggle("is-colliding", isColliding);
    };

    const onPointerUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);

      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      if (!dragging) return;
      el.classList.remove("dragging", "is-colliding");
      dragging = false;
      if (isColliding) {
        item.x = startItemX;
        item.y = startItemY;
        el.style.setProperty("--bento-item-x", `${item.x}px`);
        el.style.setProperty("--bento-item-y", `${item.y}px`);
      }
      this.debouncedSave(ctx, state, container);
      this.debouncedUpdateGridHeight(container, state.items);
    };

    this.registerDomEvent(el, "pointerdown", onPointerDown);
  }

  private makeResizable(
    el: HTMLElement,
    item: BentoItem,
    state: BentoState,
    container: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ) {
    (["right", "left", "top", "bottom"] as const).forEach((dir) => {
      const handle = el.createDiv(`resize-handle ${dir}`);
      handle.setText(dir === "right" || dir === "left" ? "↔" : "↕");

      let startX = 0;
      let startY = 0;
      let startW = 0;
      let startH = 0;
      let startItemX = 0;
      let startItemY = 0;
      let isColliding = false;

      const onPointerDown = (e: PointerEvent) => {
        e.stopPropagation();

        startX = e.clientX;
        startY = e.clientY;
        startW = item.width;
        startH = item.height;
        startItemX = item.x;
        startItemY = item.y;

        if (!handle.hasPointerCapture(e.pointerId)) {
          handle.setPointerCapture(e.pointerId);
        }
        this.registerDomEvent(window, "pointermove", onPointerMove);
        this.registerDomEvent(window, "pointerup", onPointerUp);
      };

      const onPointerMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (dir === "right") {
          item.width = startW + dx;
        }

        if (dir === "bottom") {
          item.height = startH + dy;
        }

        if (dir === "left") {
          item.width = startW - dx;
          item.x = startItemX + dx;
        }

        if (dir === "top") {
          item.height = startH - dy;
          item.y = startItemY + dy;
        }

        item.width = Math.max(50, item.width);
        item.height = Math.max(50, item.height);

        if (dir === "right") {
          item.width = Math.min(
            item.width,
            container.clientWidth - item.x,
          );
        }

        if (dir === "left" && item.x < 0) {
          const rightEdge = startItemX + startW;
          item.x = 0;
          item.width = rightEdge;
        }

        if (dir === "top" && item.y < 0) {
          const bottomEdge = startItemY + startH;
          item.y = 0;
          item.height = bottomEdge;
        }

        let snapped = false;

        if (dir === "right" || dir === "left") {
          snapped = this.trySnapWidth(
            item,
            state,
            dir,
            container,
          );
        }

        if (dir === "top" || dir === "bottom") {
          snapped = this.trySnapHeight(
            item,
            state,
            dir,
          );
        }

        if (!snapped) {
          item.width = Math.round(item.width / 5) * 5;
          item.height = Math.round(item.height / 5) * 5;
          item.x = Math.round(item.x / 5) * 5;
          item.y = Math.round(item.y / 5) * 5;
        }

        el.classList.toggle("snap-active", snapped);

        el.style.setProperty("--bento-item-width", `${item.width}px`);
        el.style.setProperty("--bento-item-height", `${item.height}px`);
        el.style.setProperty("--bento-item-x", `${item.x}px`);
        el.style.setProperty("--bento-item-y", `${item.y}px`);

        isColliding =
          this.findCollisions(item, state.items).length > 0;

        el.classList.toggle("is-colliding", isColliding);
      };

      const onPointerUp = (e: PointerEvent) => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);

        if (handle.hasPointerCapture(e.pointerId)) {
          handle.releasePointerCapture(e.pointerId);
        }

        el.classList.remove("is-colliding");
        el.classList.remove("snap-active");

        if (isColliding) {
          item.x = startItemX;
          item.y = startItemY;
          item.width = startW;
          item.height = startH;

          el.style.setProperty("--bento-item-x", `${item.x}px`);
          el.style.setProperty("--bento-item-y", `${item.y}px`);
          el.style.setProperty("--bento-item-width", `${item.width}px`);
          el.style.setProperty("--bento-item-height", `${item.height}px`);
        }

        this.debouncedSave(ctx, state, container);
        this.debouncedUpdateGridHeight(container, state.items);
      };

      this.registerDomEvent(handle, "pointerdown", onPointerDown);
    });
  }

  private findCollisions(item: BentoItem, items: BentoItem[]): BentoItem[] {
    return items.filter((other) => {
      if (other.id === item.id) return false;
      return (
        item.x < other.x + other.width &&
        item.x + item.width > other.x &&
        item.y < other.y + other.height &&
        item.y + item.height > other.y
      );
    });
  }

  private findHorizontalSnap(
    edge: number,
    items: BentoItem[],
    selfId: string,
  ): number | null {
    let best: number | null = null;
    let bestDiff = Infinity;

    for (const other of items) {
      if (other.id === selfId) continue;

      const candidates = [
        other.x, // left edge
        other.x + other.width / 2,
        other.x + other.width, // right edge
      ];

      for (const candidate of candidates) {
        const diff = Math.abs(edge - candidate);

        if (diff <= BENTO_SNAP_THRESHOLD && diff < bestDiff) {
          best = candidate;
          bestDiff = diff;
        }
      }
    }

    return best;
  }

  private findVerticalSnap(
    edge: number,
    items: BentoItem[],
    selfId: string,
  ): number | null {
    let best: number | null = null;
    let bestDiff = Infinity;

    for (const other of items) {
      if (other.id === selfId) continue;

      const candidates = [
        other.y, // top edge
        other.y + other.height / 2,
        other.y + other.height, // bottom edge
      ];

      for (const candidate of candidates) {
        const diff = Math.abs(edge - candidate);

        if (diff <= BENTO_SNAP_THRESHOLD && diff < bestDiff) {
          best = candidate;
          bestDiff = diff;
        }
      }
    }

    return best;
  }

  private trySnapWidth(
    item: BentoItem,
    state: BentoState,
    dir: "left" | "right",
    container: HTMLElement,
  ): boolean {
    const prevX = item.x;
    const prevW = item.width;

    if (dir === "right") {
      const currentRight = item.x + item.width;
      const snap = this.findHorizontalSnap(
        currentRight,
        state.items,
        item.id,
      );

      if (snap === null) return false;

      item.width = snap - item.x;
    } else {
      const currentLeft = item.x;
      const snap = this.findHorizontalSnap(
        currentLeft,
        state.items,
        item.id,
      );

      if (snap === null) return false;

      const rightEdge = item.x + item.width;
      item.x = snap;
      item.width = rightEdge - snap;
    }

    if (
      item.x < 0 ||
      item.x + item.width > container.clientWidth ||
      item.width < 50 ||
      this.findCollisions(item, state.items).length > 0
    ) {
      item.x = prevX;
      item.width = prevW;
      return false;
    }

    return true;
  }

  private trySnapHeight(
    item: BentoItem,
    state: BentoState,
    dir: "top" | "bottom",
  ): boolean {
    const prevY = item.y;
    const prevH = item.height;

    if (dir === "bottom") {
      const currentBottom = item.y + item.height;
      const snap = this.findVerticalSnap(
        currentBottom,
        state.items,
        item.id,
      );

      if (snap === null) return false;

      item.height = snap - item.y;
    } else {
      const currentTop = item.y;
      const snap = this.findVerticalSnap(
        currentTop,
        state.items,
        item.id,
      );

      if (snap === null) return false;

      const bottomEdge = item.y + item.height;
      item.y = snap;
      item.height = bottomEdge - snap;
    }

    if (
      item.y < 0 ||
      item.height < 50 ||
      this.findCollisions(item, state.items).length > 0
    ) {
      item.y = prevY;
      item.height = prevH;
      return false;
    }

    return true;
  }

  private saveBackToNote(
    ctx: MarkdownPostProcessorContext,
    state: BentoState,
    container: HTMLElement,
  ) {
    if (this.isRendering) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== ctx.sourcePath) return;

    const editor = view.editor;
    const code: HTMLElement | null = container.closest(".block-language-bento");
    if (!code) return;

    const info = ctx.getSectionInfo(code);
    if (!info) return;

    const full = editor.getValue();
    const lines = full.split("\n");

    let start = info.lineStart;
    while (start >= 0 && !/^```bento\b/.test(lines[start])) start--;
    if (start < 0) return;

    let end = start + 1;
    while (end < lines.length && !/^```/.test(lines[end])) end++;
    if (end >= lines.length) end = lines.length - 1;

    const newBlock = "```bento\n" + JSON.stringify(state, null, 2) + "\n```";
    editor.replaceRange(
      newBlock,
      { line: start, ch: 0 },
      { line: end, ch: lines[end].length },
    );
  }
}
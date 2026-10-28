import { EditorView } from "@codemirror/view";
import {
  Component,
  Editor,
  HeadingCache,
  MarkdownFileInfo,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Keymap,
  MarkdownPreviewRenderer,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  PaneType,
  Plugin,
  TFile,
  parseLinktext,
  setIcon,
} from "obsidian";
import { EXTERNAL_LINK_RE, createCardEditor } from "./cardEditor";
import { nutshellLivePreview } from "./livePreview";
import { Term, findTerm, inlineTerm, parseTerms } from "./terms";

/**
 * Nutshell for Obsidian
 * --------------------
 * Click a term to open a small floating **popup card** with its explanation,
 * rendered with Obsidian's own engine (math, images and nested terms work).
 * The note body never reflows. Two kinds of term (syntax in terms.ts):
 *
 * - Inline: `[:crystal]%% definition %%`. The definition is hidden in an
 *   Obsidian comment next to the term. The "Create nutshell from selection"
 *   command makes one and opens its card in edit mode; the card's pencil
 *   edits it later.
 * - Link (Nicky Case's convention): `[:beta](<#Beta Distribution>)` opens that
 *   heading's section. Definition headings written with a leading colon
 *   (`## :Beta Distribution`) are hidden from the reading-mode body.
 */

interface ActivePopup {
  el: HTMLElement; // the floating overlay (child of document.body)
  component: Component; // owns the rendered markdown tree + nested popups
  trigger: HTMLElement | null; // the term that opened this card; null when opened by the create command
  owner: Component; // section render-child, the parent card's render tree, or the plugin
  reposition: (fromScroll?: boolean) => void; // re-anchor under the term (after a scroll)
}

interface ResolvedTarget {
  markdown: string;
  file: TFile;
  want: string | null; // normalized heading name; null when the link targets a whole note
}

/** What a card shows; `save` is null for read-only cards. */
interface Definition {
  markdown: string;
  path: string; // note the definition belongs to (for resolving links/embeds)
  save: ((body: string) => void) | null;
}

/** Loads a card's definition, or returns an error message to show instead. */
type DefinitionLoader = () => Promise<Definition | string>;

/** Markdown behind rendered content, used to find inline definitions. */
interface InlineSource {
  text: string;
  offset: number; // where `text` starts in the note; a hint for finding a term again
  file: TFile | null; // note that edits are written to; null = read-only
}

interface PopupOptions {
  anchor?: () => { left: number; right: number; top: number; bottom: number } | null; // term position when there is no trigger (null: not rendered)
  column?: HTMLElement; // editor content element whose line width bounds the card when there is no trigger
  edit?: boolean; // open straight into the definition editor
  onClose?: () => void;
}

const POPUP_MARGIN = 6; // gap between the term and the card
const VIEWPORT_MARGIN = 8; // closest the card gets to the window edge
// One block of the note's text column: a line/block in Live Preview, a section
// in reading view. Themes like Minimal put the readable width on these blocks
// rather than on .cm-content / the sizer, which can be as wide as the pane.
const COLUMN_SELECTOR = ".cm-content > *, .markdown-preview-sizer > *";
// What scrolls a term: the editor, reading view, or (for nested terms) a card.
const SCROLLER_SELECTOR = ".cm-scroller, .markdown-preview-view, .nutshell-popup";
// A line containing only `%% end %%` (an Obsidian comment, invisible in reading
// view) closes a definition early. Without it, a definition runs to the next
// heading of equal-or-higher level.
const END_MARKER_RE = /^\s*%%\s*end\s*%%\s*$/i;

/** The outermost column block around `el`, skipping the nested editors/sizers of embeds and table cells. */
function columnOf(el: Element | null | undefined): HTMLElement | null {
  let column: HTMLElement | null = null;
  for (
    let e = el?.closest<HTMLElement>(COLUMN_SELECTOR);
    e;
    e = e.parentElement?.closest<HTMLElement>(COLUMN_SELECTOR)
  ) {
    column = e;
  }
  return column;
}

/**
 * Map a spot in rendered markdown (text `node` at `off`) back to an offset in
 * its `source`: take the text around the spot, work out which occurrence of it
 * in the rendered text this is, and find the same occurrence in the source.
 * Null when the spot can't be matched (e.g. inside rendered math or an image).
 */
function sourceOffsetOf(
  root: HTMLElement,
  node: Text,
  off: number,
  source: string,
): number | null {
  if (!root.contains(node)) return null;
  const before = node.data.slice(Math.max(0, off - 20), off);
  const snippet = before + node.data.slice(off, off + 20);
  if (!snippet.trim()) return null;

  // Rendered text up to the snippet, skipping math (its rendered text differs
  // from its source), to count which occurrence of the snippet this is.
  let rendered = "";
  const walker = root.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && n !== node; n = walker.nextNode()) {
    if (n.instanceOf(Text) && !n.parentElement?.closest(".math, mjx-container, button")) {
      rendered += n.data;
    }
  }
  rendered += node.data.slice(0, off - before.length) + snippet;
  let nth = 0;
  for (let i = rendered.indexOf(snippet); i !== -1; i = rendered.indexOf(snippet, i + 1)) {
    nth++;
  }
  let at = -1;
  for (let k = 0; k < nth; k++) {
    const next = source.indexOf(snippet, at + 1);
    if (next === -1) break;
    at = next;
  }
  return at === -1 ? null : at + before.length;
}

/** Map a click point on rendered markdown back to an offset in its `source`. */
function sourceOffsetAt(
  root: HTMLElement,
  x: number,
  y: number,
  source: string,
): number | null {
  const hit = root.doc.caretRangeFromPoint(x, y);
  const node = hit?.startContainer;
  return hit && node?.instanceOf(Text)
    ? sourceOffsetOf(root, node, hit.startOffset, source)
    : null;
}

/**
 * The range of `source` behind a text selection made in rendered markdown
 * under `root`. Null when there's no selection there, or it can't be mapped
 * exactly (e.g. it spans formatting, whose markup isn't in the rendered text).
 */
function selectionIn(
  root: HTMLElement,
  source: string,
): { anchor: number; head: number } | null {
  const sel = root.win.getSelection(); // each window has its own selection
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!r.startContainer.instanceOf(Text) || !r.endContainer.instanceOf(Text)) return null;
  const from = sourceOffsetOf(root, r.startContainer, r.startOffset, source);
  const to = sourceOffsetOf(root, r.endContainer, r.endOffset, source);
  if (from === null || to === null || from >= to) return null;
  return source.slice(from, to).trim() === sel.toString().trim()
    ? { anchor: from, head: to }
    : null;
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const IMAGE_EXT_RE = /^(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
// File extensions for pasted image types that don't match their MIME subtype.
const IMAGE_EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};
const FENCE_RE = /^ {0,3}(```|~~~)/;
const SAVE_DELAY_MS = 400;
// A term label can't span lines, contain brackets, or start with a colon.
const INVALID_LABEL_RE = /^:|[\n[\]]/;
const INVALID_LABEL_MSG =
  "Nutshell: select a word or phrase first (no line breaks or brackets).";
const NO_CARD_EDITOR_MSG =
  "Nutshell: click into the card's text first (cards for whole notes can't be edited).";

/** The card editor that has keyboard focus, if any. */
function focusedCardEditor(): EditorView | null {
  // activeDocument: the focused window, which may be a popout.
  const el = activeDocument.activeElement?.closest(".cm-editor.nutshell-editor");
  return el?.instanceOf(HTMLElement) ? EditorView.findFromDOM(el) : null;
}

/**
 * Whether a code block language renders as something other than code, the
 * same test Obsidian's editor uses (`canRenderLang`): mermaid, search queries,
 * or a plugin's code block processor (```wave…). The processor registry isn't
 * public; if it ever goes away, plugin blocks just stay as source in cards.
 */
function canRenderCodeBlock(language: string): boolean {
  if (language === "mermaid" || language === "query") return true;
  if (!("codeBlockPostProcessors" in MarkdownPreviewRenderer)) return false;
  const processors = MarkdownPreviewRenderer.codeBlockPostProcessors;
  return (
    typeof processors === "object" &&
    processors !== null &&
    Object.prototype.hasOwnProperty.call(processors, language)
  );
}

/** Forgiving heading match: drop a leading colon, lowercase, trim. */
function normalizeHeading(s: string): string {
  return s.replace(/^:\s*/, "").trim().toLowerCase();
}

/**
 * Locate the body of heading `want` (normalized) in `text` as character offsets
 * [from, to): `from` is the end of the heading line, `to` is just before the
 * line that closes it (`%% end %%` or the next heading of equal-or-higher
 * level), or the end of the text. Headings inside code fences are ignored.
 */
function findSection(
  text: string,
  want: string,
): { from: number; to: number } | null {
  let offset = 0;
  let fence: string | null = null;
  let open: { level: number; from: number } | null = null;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const f = FENCE_RE.exec(line);
    if (f) {
      fence = fence === null ? f[1] : f[1] === fence ? null : fence;
      continue;
    }
    if (fence) continue;
    const h = HEADING_RE.exec(line);
    if (open) {
      if (END_MARKER_RE.test(line) || (h && h[1].length <= open.level)) {
        return { from: open.from, to: start - 1 };
      }
    } else if (h && normalizeHeading(h[2] ?? "") === want) {
      open = { level: h[1].length, from: start + line.length };
    }
  }
  return open && { from: open.from, to: text.length };
}

export default class NutshellPlugin extends Plugin {
  private openPopups: ActivePopup[] = [];
  /** Card editors → the card they belong to (for creating terms inside them). */
  private cardEditors = new WeakMap<EditorView, { owner: Component; path: string }>();
  /** Windows that already have the card handling (see watchWindow). */
  private watchedWindows = new WeakSet<Window>();

  async onload() {
    this.registerMarkdownPostProcessor((el, ctx) => {
      this.hideDefinitionBlocks(el, ctx);
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      // Cards belong to the plugin, not the section: saving an edit re-renders
      // the section, which must not close the card being typed in.
      this.wireTriggers(el, child, this, ctx.sourcePath, this.inlineSourceOf(el, ctx));
    });

    // Live Preview: the same cards from terms in the editor.
    this.registerEditorExtension(
      nutshellLivePreview((trigger, sourcePath, term) =>
        this.togglePopup(
          trigger,
          this,
          typeof term === "string"
            ? this.linkLoader(term, sourcePath)
            : this.inlineLoader(sourcePath, term),
        ),
      ),
    );

    // Works in a note's editor, and inside a card's editor (creating a term
    // within that definition), the same way in both.
    this.addCommand({
      id: "create-from-selection",
      name: "Create nutshell from selection",
      checkCallback: (checking) => {
        const card = focusedCardEditor();
        const active = this.app.workspace.activeEditor;
        const editor = active?.editor;
        if (!card && !editor) return false;
        if (checking) return true;
        if (card) this.createInCard(card);
        // A card is open but neither it nor the note has focus: never fall
        // back to wrapping whatever word is at the note's cursor.
        else if (this.openPopups.length > 0 && !editor?.hasFocus()) {
          new Notice(NO_CARD_EDITOR_MSG);
        } else if (active && editor) this.createFromSelection(editor, active);
        return true;
      },
    });

    // Dismissal, Esc and scroll-following, in the main window and in every
    // popout window (each has its own document and events): popouts opened
    // later, and ones already open when the plugin loads (after a reload,
    // Obsidian restores them). openPopup also covers its card's window.
    this.watchWindow(window);
    this.app.workspace.onLayoutReady(() =>
      this.app.workspace.iterateAllLeaves((leaf) => this.watchWindow(leaf.getContainer().win)),
    );
    this.registerEvent(
      this.app.workspace.on("window-open", (_popout, win) => this.watchWindow(win)),
    );
    // A closing popout takes its cards with it (their edits are saved first).
    this.registerEvent(
      this.app.workspace.on("window-close", (_popout, win) => {
        const popup = this.openPopups.find((p) => p.el.win === win);
        if (popup) this.closePopup(popup);
      }),
    );
  }

  /**
   * Window-wide card handling for `win`: a click outside any card (and not on
   * a trigger) closes all; Esc closes the topmost; cards follow their term
   * when anything scrolls (capture: scroll events don't bubble) or the window
   * resizes, at most once per frame.
   */
  private watchWindow(win: Window) {
    if (this.watchedWindows.has(win)) return;
    this.watchedWindows.add(win);
    const doc = win.document;
    this.registerDomEvent(doc, "mousedown", (e) => {
      if (this.openPopups.length === 0) return;
      const target = e.target as HTMLElement | null;
      // Obsidian's overlays (command palette, menus, suggestions) keep cards
      // open, so a command picked there still reaches the focused card.
      if (target?.closest(".modal-container, .menu, .suggestion-container")) return;
      const inPopup = this.openPopups.some((p) => target && p.el.contains(target));
      const onTrigger = target?.closest(".nutshell-trigger");
      if (!inPopup && !onTrigger) this.closeAll();
    });
    this.registerDomEvent(doc, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.openPopups.length > 0) {
        this.closePopup(this.openPopups[this.openPopups.length - 1]);
      }
    });
    let frame = 0;
    const follow = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        for (const popup of this.openPopups) popup.reposition(true);
      });
    };
    this.registerDomEvent(doc, "scroll", follow, { capture: true });
    this.registerDomEvent(win, "resize", follow);
  }

  onunload() {
    this.closeAll();
  }

  // — Trigger wiring (also called on rendered popup content for recursion) —

  /**
   * Turn the terms in rendered markdown into triggers. Link terms arrive as
   * `<a>` elements whose text starts with `:`. Inline terms arrive as plain
   * `[:label]` text (Obsidian already stripped the `%%` comment), so their
   * definitions are read from `source`. Listeners belong to `owner`; cards
   * opened from them belong to `cardOwner`.
   */
  private wireTriggers(
    rootEl: HTMLElement,
    owner: Component,
    cardOwner: Component,
    sourcePath: string,
    source: InlineSource | null,
    define?: (term: Term) => Definition, // overrides how an inline term's card reads/saves it
  ) {
    rootEl.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
      const text = a.textContent ?? "";
      if (!text.startsWith(":")) return;
      const rawTarget =
        a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
      const trigger = this.makeTrigger(text.replace(/^:\s*/, ""), owner, () =>
        this.togglePopup(trigger, cardOwner, this.linkLoader(rawTarget, sourcePath)),
      );
      a.replaceWith(trigger);
    });

    if (!source) return;
    const terms = parseTerms(source.text, source.offset).filter(
      (t) => t.target === null,
    );
    if (terms.length === 0) return;
    const nodes: Text[] = [];
    const walker = rootEl.doc.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (
        n.instanceOf(Text) &&
        n.data.includes("[:") &&
        !n.parentElement?.closest("code, pre, .math")
      ) {
        nodes.push(n);
      }
    }
    for (const node of nodes) {
      const parts: (string | HTMLElement)[] = [];
      const re = /\[:([^\]\n]+)\]/g;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(node.data))) {
        // Pair each rendered `[:label]` with the next unused source term of that label.
        const label = m[1].replace(/^\s+/, "");
        const i = terms.findIndex((t) => t.label === label);
        if (i < 0) continue;
        const term = terms.splice(i, 1)[0];
        const trigger = this.makeTrigger(label, owner, () =>
          this.togglePopup(trigger, cardOwner, async () =>
            define
              ? define(term)
              : this.inlineDefinition(source.file, source.file?.path ?? sourcePath, term),
          ),
        );
        parts.push(node.data.slice(last, m.index), trigger);
        last = m.index + m[0].length;
      }
      if (last === 0) continue;
      parts.push(node.data.slice(last));
      node.replaceWith(...parts);
    }
  }

  private makeTrigger(
    label: string,
    owner: Component,
    activate: () => void,
  ): HTMLElement {
    const trigger = createSpan({
      cls: "nutshell-trigger",
      text: label,
      attr: { role: "button", tabindex: "0" },
    });
    const fire = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      activate();
    };
    owner.registerDomEvent(trigger, "click", fire);
    owner.registerDomEvent(trigger, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") fire(e);
    });
    return trigger;
  }

  /** The reading-view section's markdown, when it may contain inline terms. */
  private inlineSourceOf(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): InlineSource | null {
    if (!el.textContent?.includes("[:")) return null;
    const info = ctx.getSectionInfo(el);
    if (!info) return null;
    const lines = info.text.split("\n");
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    return {
      text: lines.slice(info.lineStart, info.lineEnd + 1).join("\n"),
      offset: lines
        .slice(0, info.lineStart)
        .reduce((n, line) => n + line.length + 1, 0),
      file: file instanceof TFile ? file : null,
    };
  }

  // — Popup lifecycle —

  private togglePopup(
    trigger: HTMLElement,
    owner: Component,
    load: DefinitionLoader,
  ) {
    const existing = this.openPopups.find((p) => p.trigger === trigger);
    if (existing) {
      this.closePopup(existing);
      return;
    }
    void this.openPopup(trigger, owner, load);
  }

  private async openPopup(
    trigger: HTMLElement | null,
    owner: Component,
    load: DefinitionLoader,
    options: PopupOptions = {},
  ) {
    // The card lives in the window its term is in (a popout has its own page).
    const doc = (trigger ?? options.column)?.doc ?? activeDocument;
    const overlay = doc.body.createDiv({ cls: "nutshell-popup" });
    if (doc.defaultView) this.watchWindow(doc.defaultView); // so clicking outside / Esc close it there
    const content = overlay.createDiv({ cls: "nutshell-popup-content" });
    let expanded = false; // large centered panel instead of a card under the term
    const reposition = (fromScroll = false) => {
      if (expanded) {
        // Layout comes from `.is-expanded` in styles.css.
        overlay.style.top = overlay.style.left = overlay.style.maxWidth = "";
        return;
      }
      if (trigger && !trigger.isConnected) {
        // A save re-rendered the note: stay put. Scrolled far enough that the
        // editor dropped the term: hide until the card is closed.
        if (fromScroll) overlay.addClass("is-offscreen");
        return;
      }
      const rect = trigger
        ? trigger.getBoundingClientRect()
        : options.anchor
          ? options.anchor()
          : { left: 80, right: 80, top: 80, bottom: 80 };
      // Hide while the term is scrolled out of its note (or card), so the card
      // doesn't float over headers; it comes back with the term.
      const view = (trigger ?? options.column)
        ?.closest(SCROLLER_SELECTOR)
        ?.getBoundingClientRect();
      if (!rect || (view && (rect.bottom <= view.top || rect.top >= view.bottom))) {
        overlay.addClass("is-offscreen");
        return;
      }
      overlay.removeClass("is-offscreen");
      // Resolved on every reposition: CodeMirror recycles line elements.
      const column = trigger
        ? columnOf(trigger)
        : columnOf(options.column?.querySelector(":scope > .cm-line"));
      this.positionPopup(overlay, rect, column);
    };

    const component = new Component();
    owner.addChild(component); // ties lifecycle to the owner (plugin or parent card)

    const popup: ActivePopup = { el: overlay, component, trigger, owner, reposition };
    this.openPopups.push(popup);
    trigger?.addClass("is-open");

    // Teardown path: whenever the component unloads (explicit close, parent
    // card close, or plugin unload), remove the overlay and de-list the popup.
    component.register(() => {
      trigger?.removeClass("is-open");
      overlay.remove();
      const i = this.openPopups.indexOf(popup);
      if (i >= 0) this.openPopups.splice(i, 1);
      options.onClose?.();
    });

    content.setText("…");
    reposition();

    const def = await load();
    if (!this.openPopups.includes(popup)) return; // closed while loading
    content.empty();
    if (typeof def === "string") {
      content.createSpan({ cls: "nutshell-error", text: def });
      reposition();
      return;
    }

    // Links in the rendered definition open like links in a note (nothing
    // else handles clicks here: the card isn't inside a note view).
    content.addEventListener("click", (e) => {
      const target = e.targetNode;
      const a = target?.instanceOf(Element) ? target.closest("a") : null;
      if (!a || a.hasClass("tag")) return;
      const href = a.getAttribute("data-href") ?? a.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      this.openLink(href, def.path, Keymap.isModEvent(e));
    });

    // Editable cards switch to a markdown editor when their text is clicked;
    // it writes back into the note as you type.
    const { save: persist } = def;
    let body = def.markdown;
    let rendered: Component | null = null; // current render tree; owns nested cards
    let editor: EditorView | null = null;
    let saveTimer: number | null = null;

    const save = () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = null;
      if (!editor || !persist) return;
      const next = editor.state.doc.toString().trim();
      if (next === body) return;
      body = next;
      persist(next);
    };
    const closeEditor = () => {
      save();
      editor?.destroy();
      editor = null;
    };
    const showRendered = async () => {
      closeEditor();
      content.empty();
      rendered = new Component();
      component.addChild(rendered);
      if (!body && persist) {
        content.createDiv({
          cls: "nutshell-empty",
          text: "No definition yet. Click here to write one.",
        });
      }
      await MarkdownRenderer.render(this.app, body, content, def.path, rendered);
      // Recursion: wire nested terms explicitly against this render tree (do
      // not rely on post-processor re-entry). Nested inline terms are stored
      // inside this definition, so their cards edit it here and save it.
      this.wireTriggers(
        content,
        rendered,
        rendered,
        def.path,
        { text: body, offset: 0, file: null },
        persist
          ? (term) => {
              const ref = { raw: term.raw, at: term.from };
              return {
                markdown: term.definition,
                path: def.path,
                save: (nested) => {
                  const cur = findTerm(body, ref);
                  if (!cur) return;
                  const next = inlineTerm(term.label, nested);
                  body = body.slice(0, cur.from) + next + body.slice(cur.to);
                  ref.raw = next;
                  ref.at = cur.from;
                  persist(body);
                },
              };
            }
          : undefined,
      );
      reposition();
    };
    /**
     * Switch to the editor with the selection `sel` (a cursor when `head` is
     * omitted). `clickY` is where the user clicked (viewport y); the card
     * scrolls so the cursor lands there.
     */
    const showEditor = (
      sel: { anchor: number; head?: number } = { anchor: body.length },
      clickY?: number,
    ) => {
      if (rendered) component.removeChild(rendered); // also closes nested cards
      rendered = null;
      content.empty();
      const view = createCardEditor(content, body, {
        onChange: () => {
          if (saveTimer !== null) window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(save, SAVE_DELAY_MS);
        },
        resolveImage: (target) => this.imageUrl(target, def.path),
        saveImage: (image, dropped) => this.saveImage(image, dropped, def.path),
        embedDropped: (text) => this.embedForDroppedFile(text, def.path),
        openLink: (href, newLeaf) => this.openLink(href, def.path, newLeaf),
        // Plugin blocks render through Obsidian; each render's children
        // (e.g. a plot's resize observer) unload with the block or the card.
        codeBlocks: {
          canRender: canRenderCodeBlock,
          render: (markdown, el) => {
            const child = component.addChild(new Component());
            void MarkdownRenderer.render(this.app, markdown, el, def.path, child);
            return () => component.removeChild(child);
          },
        },
        // Terms inside the definition stay clickable while editing; their
        // cards close with this one.
        terms: {
          sourcePath: def.path,
          open: (trigger, _path, term) =>
            this.openCardTerm(trigger, term, view, component, def.path),
        },
      });
      editor = view;
      this.cardEditors.set(view, { owner: component, path: def.path });
      reposition();
      const len = view.state.doc.length;
      view.dispatch({
        selection: {
          anchor: Math.min(sel.anchor, len),
          head: Math.min(sel.head ?? sel.anchor, len),
        },
      });
      view.focus();
      if (clickY !== undefined) {
        view.requestMeasure({
          read: (v) => v.coordsAtPos(v.state.selection.main.head),
          write: (coords) => {
            if (coords) overlay.scrollTop += (coords.top + coords.bottom) / 2 - clickY;
          },
        });
      }
    };
    component.register(closeEditor); // flush pending edits when the card closes

    // Toolbar row: expand/collapse.
    const toolbar = overlay.createDiv({ cls: "nutshell-toolbar" });
    overlay.prepend(toolbar); // first, above the content
    const expand = toolbar.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Expand" },
    });
    setIcon(expand, "maximize-2");
    expand.addEventListener("click", () => {
      expanded = !expanded;
      overlay.toggleClass("is-expanded", expanded);
      setIcon(expand, expanded ? "minimize-2" : "maximize-2");
      expand.setAttribute("aria-label", expanded ? "Collapse" : "Expand");
      reposition();
      editor?.focus();
    });
    if (persist) {
      // Clicking the rendered text switches to editing at that spot, and a
      // text selection switches to editing with that text selected (so the
      // create command works on it, as in a note). Links, nested terms and
      // plugin output (a plot's sliders, form controls) are left alone.
      // Handled on mouseup anywhere, since a drag-selection can end outside
      // the card.
      overlay.addClass("is-editable");
      content.addEventListener("mousedown", (down) => {
        if (editor || down.button !== 0) return;
        const target = down.targetNode;
        if (
          target?.instanceOf(Element) &&
          target.closest('a, .nutshell-trigger, [class*="block-language-"], input, select, textarea, button')
        ) {
          return;
        }
        doc.addEventListener(
          "mouseup",
          (up) => {
            if (editor || !content.isConnected) return;
            const at = sourceOffsetAt(content, up.clientX, up.clientY, body);
            showEditor(selectionIn(content, body) ?? { anchor: at ?? body.length }, up.clientY);
          },
          { once: true },
        );
      });
    }
    if (options.edit && persist) showEditor();
    else await showRendered();
  }

  /**
   * Save a pasted or dropped image the way Obsidian's editor does: a dropped
   * file keeps its name, a pasted image is named "Pasted image <timestamp>";
   * stored per the vault's attachment setting and linked with the vault's link
   * style. Returns the embed markdown, or null on failure.
   */
  private async saveImage(
    image: File,
    dropped: boolean,
    sourcePath: string,
  ): Promise<string | null> {
    const ext = IMAGE_EXT_BY_TYPE[image.type] ?? image.type.slice("image/".length);
    // Local time as YYYYMMDDHHmmss, like Obsidian's own pasted images.
    const d = new Date();
    const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join("");
    const name = dropped && image.name ? image.name : `Pasted image ${stamp}.${ext}`;
    try {
      const path = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
      const file = await this.app.vault.createBinary(path, await image.arrayBuffer());
      return `!${this.app.fileManager.generateMarkdownLink(file, sourcePath)}`;
    } catch (e) {
      new Notice(`Nutshell: couldn't save the image (${e instanceof Error ? e.message : e}).`);
      return null;
    }
  }

  /**
   * Link for a file dragged in from Obsidian itself (file list, search…):
   * Obsidian puts its `obsidian://open?vault=…&file=…` URL in the drag data.
   * Images are embedded, other files linked. Null for anything else.
   */
  private embedForDroppedFile(text: string, sourcePath: string): string | null {
    let url: URL;
    try {
      url = new URL(text.trim());
    } catch {
      return null;
    }
    const path = url.protocol === "obsidian:" ? url.searchParams.get("file") : null;
    const file = path ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath) : null;
    if (!file) return null;
    const link = this.app.fileManager.generateMarkdownLink(file, sourcePath);
    return IMAGE_EXT_RE.test(file.extension) ? `!${link}` : link;
  }

  /** URL for an image embed target (vault file or web URL); null if it isn't an image. */
  private imageUrl(target: string, sourcePath: string): string | null {
    if (/^https?:\/\//i.test(target)) return target;
    let path = target;
    try {
      path = decodeURIComponent(target);
    } catch {
      /* keep as written */
    }
    const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    return file && IMAGE_EXT_RE.test(file.extension)
      ? this.app.vault.getResourcePath(file)
      : null;
  }

  private closePopup(popup: ActivePopup) {
    const idx = this.openPopups.indexOf(popup);
    if (idx === -1) return;
    // Close this card and every card stacked above it (its descendants).
    const toClose = this.openPopups.slice(idx).reverse();
    for (const p of toClose) {
      p.owner.removeChild(p.component); // unload → register() cleans up DOM + stack
    }
  }

  private closeAll() {
    if (this.openPopups.length > 0) this.closePopup(this.openPopups[0]);
  }

  /**
   * Open a link from a card: a URL in the browser, a note (or heading) in
   * Obsidian. Opening a note in this tab replaces the one the cards belong
   * to, so they close first (saving any edits).
   */
  private openLink(href: string, sourcePath: string, newLeaf: PaneType | boolean) {
    if (EXTERNAL_LINK_RE.test(href)) {
      window.open(href);
      return;
    }
    if (!newLeaf) this.closeAll();
    void this.app.workspace.openLinkText(href, sourcePath, newLeaf);
  }

  /**
   * Place the card below (or above) the anchor, centered on it horizontally but
   * kept inside the note's text column (or the window when there is none).
   */
  private positionPopup(
    overlay: HTMLElement,
    r: { left: number; right: number; top: number; bottom: number },
    column: HTMLElement | null,
  ) {
    // A detached or zero-width column must never shrink the card to nothing.
    const c = column?.isConnected ? column.getBoundingClientRect() : undefined;
    const bounded = c !== undefined && c.width > 0;
    const minLeft = bounded ? c.left : VIEWPORT_MARGIN;
    const win = overlay.win; // the card's window, which may be a popout
    const maxRight = bounded ? c.right : win.innerWidth - VIEWPORT_MARGIN;
    overlay.style.maxWidth = `${maxRight - minLeft}px`; // narrow columns shrink the card

    const pr = overlay.getBoundingClientRect();
    let top = r.bottom + POPUP_MARGIN;
    if (
      top + pr.height > win.innerHeight &&
      r.top - POPUP_MARGIN - pr.height > 0
    ) {
      top = r.top - POPUP_MARGIN - pr.height; // flip above when no room below
    }
    const left = Math.min(
      (r.left + r.right) / 2 - pr.width / 2,
      maxRight - pr.width,
    );
    overlay.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
    overlay.style.left = `${Math.max(minLeft, left)}px`;
  }

  // — Target resolution (hidden-heading aware) —

  private async resolveTarget(
    rawTarget: string,
    sourcePath: string,
  ): Promise<ResolvedTarget | null> {
    let target = rawTarget;
    try {
      target = decodeURIComponent(rawTarget);
    } catch {
      /* leave as-is if not valid percent-encoding */
    }

    const { path, subpath } = parseLinktext(target);

    let file: TFile | null;
    if (path) {
      file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    } else {
      const af = this.app.vault.getAbstractFileByPath(sourcePath);
      file = af instanceof TFile ? af : null;
    }
    if (!file) return null;

    // Prefer an open editor's buffer: it can be ahead of the file on disk
    // (e.g. a definition the create command just added).
    const text =
      this.editorFor(file)?.getValue() ??
      (await this.app.vault.cachedRead(file));
    if (!subpath) return { markdown: text, file, want: null };

    const want = normalizeHeading(subpath.replace(/^#+/, ""));
    const section = findSection(text, want);
    if (!section) return null;
    return {
      markdown: text.slice(section.from, section.to).trim(),
      file,
      want,
    };
  }

  // — Loading and saving definitions —

  private linkLoader(rawTarget: string, sourcePath: string): DefinitionLoader {
    return async () => {
      const resolved = await this.resolveTarget(rawTarget, sourcePath);
      if (!resolved) return `⚠️ Nutshell: couldn't resolve "${rawTarget}".`;
      const { file, want } = resolved;
      return {
        markdown: resolved.markdown,
        path: file.path,
        save:
          want === null
            ? null
            : (body) => void this.writeDefinition(file, want, body),
      };
    };
  }

  /** Loader for the inline term at document offset `at` (read when opened). */
  private inlineLoader(sourcePath: string, at: number): DefinitionLoader {
    return async () => {
      const file = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(file instanceof TFile)) return "⚠️ Nutshell: this note isn't a file.";
      const text =
        this.editorFor(file)?.getValue() ??
        (await this.app.vault.cachedRead(file));
      const term = parseTerms(text).find(
        (t) => t.target === null && t.from <= at && at < t.to,
      );
      if (!term) return "⚠️ Nutshell: couldn't find this term in the note.";
      return this.inlineDefinition(file, file.path, term);
    };
  }

  /** Card content for an inline term; edits rewrite the term in `file`. */
  private inlineDefinition(
    file: TFile | null,
    path: string,
    term: Term,
  ): Definition {
    const ref = { raw: term.raw, at: term.from };
    return {
      markdown: term.definition,
      path,
      save: file && ((body) => void this.writeInline(file, term.label, ref, body)),
    };
  }

  private createFromSelection(
    editor: Editor,
    ctx: MarkdownView | MarkdownFileInfo,
  ) {
    const file = ctx.file;
    if (!file) return;
    // Nothing selected → use the word under the cursor.
    if (!editor.somethingSelected()) {
      const word = editor.wordAt(editor.getCursor());
      if (word) editor.setSelection(word.from, word.to);
    }
    const selected = editor.getSelection();
    const label = selected.trim();
    if (!label || INVALID_LABEL_RE.test(label)) {
      new Notice(INVALID_LABEL_MSG);
      return;
    }
    // Keep any whitespace the selection picked up around the term.
    const at = selected.indexOf(label);
    const from = editor.posToOffset(editor.getCursor("from")) + at;
    editor.replaceSelection(
      `${selected.slice(0, at)}${inlineTerm(label, "")}${selected.slice(at + label.length)}`,
    );

    // Open the card in edit mode just below the cursor. `cm` is Obsidian's CM6
    // view; it is not in the public typings, so fall back to a fixed spot.
    const cm = "cm" in editor ? editor.cm : null;
    const view = cm instanceof EditorView ? cm : null;
    void this.openPopup(null, this, this.inlineLoader(file.path, from), {
      anchor: view ? () => view.coordsAtPos(from) : undefined, // follows the new term
      column: view?.contentDOM,
      edit: true,
      onClose: () => editor.focus(),
    });
  }

  /** Rewrite an inline term with a new definition. */
  private async writeInline(
    file: TFile,
    label: string,
    ref: { raw: string; at: number },
    body: string,
  ) {
    const next = inlineTerm(label, body);
    const hit = await this.spliceNote(file, next, (text) => findTerm(text, ref));
    if (!hit) {
      new Notice(`Nutshell: couldn't find "${label}" in the note to save.`);
      return;
    }
    ref.raw = next;
    ref.at = hit.from;
  }

  /**
   * Create a term inside a card's editor from its selection (or the word at the
   * cursor), then open the new term's card in edit mode. Its definition is
   * stored inside the outer definition, which saves it to the note.
   */
  private createInCard(view: EditorView) {
    const card = this.cardEditors.get(view);
    if (!card) return;
    let { from, to } = view.state.selection.main;
    if (from === to) ({ from, to } = view.state.wordAt(from) ?? { from, to });
    const selected = view.state.sliceDoc(from, to);
    const label = selected.trim();
    if (!label || INVALID_LABEL_RE.test(label)) {
      new Notice(INVALID_LABEL_MSG);
      return;
    }
    const start = from + selected.indexOf(label);
    const term = inlineTerm(label, "");
    view.dispatch({
      changes: { from: start, to: start + label.length, insert: term },
      selection: { anchor: start + term.length },
    });
    void this.openPopup(null, card.owner, this.cardTermLoader(view, start, card.path), {
      anchor: () => view.coordsAtPos(start),
      column: view.contentDOM, // positioned and hidden against the outer card
      edit: true,
      onClose: () => view.focus(),
    });
  }

  /** Open a term clicked inside a card's editor: a link target, or the offset of an inline term in `view`. */
  private openCardTerm(
    trigger: HTMLElement,
    term: string | number,
    view: EditorView,
    owner: Component,
    path: string,
  ) {
    const load =
      typeof term === "string"
        ? this.linkLoader(term, path)
        : this.cardTermLoader(view, term, path);
    this.togglePopup(trigger, owner, load);
  }

  /**
   * Loader for the inline term at offset `at` in a card's editor. Its
   * definition is stored inside the outer definition, so saving edits it there
   * (the outer card then saves it to the note).
   */
  private cardTermLoader(view: EditorView, at: number, path: string): DefinitionLoader {
    return async () => {
      const hit = parseTerms(view.state.doc.toString()).find(
        (t) => t.target === null && t.from <= at && at < t.to,
      );
      if (!hit) return "⚠️ Nutshell: couldn't find this term.";
      const ref = { raw: hit.raw, at: hit.from };
      return {
        markdown: hit.definition,
        path,
        save: (body) => {
          if (!view.dom.isConnected) return; // outer editor already closed
          const current = findTerm(view.state.doc.toString(), ref);
          if (!current) return;
          const next = inlineTerm(hit.label, body);
          view.dispatch({ changes: { from: current.from, to: current.to, insert: next } });
          ref.raw = next;
          ref.at = current.from;
        },
      };
    };
  }

  /** Replace the body of heading definition `want` in `file`. */
  private async writeDefinition(file: TFile, want: string, body: string) {
    const hit = await this.spliceNote(
      file,
      body ? `\n\n${body}\n` : "\n",
      (text) => findSection(text, want),
    );
    if (!hit) {
      new Notice(`Nutshell: couldn't find the "${want}" definition to save.`);
    }
  }

  /**
   * Replace the range `locate` finds in `file` with `insert`. Goes through the
   * note's open editor when there is one (keeps undo and the cursor, and sees
   * unsaved text); otherwise edits the file on disk. Returns the range found.
   */
  private async spliceNote(
    file: TFile,
    insert: string,
    locate: (text: string) => { from: number; to: number } | null,
  ): Promise<{ from: number; to: number } | null> {
    const editor = this.editorFor(file);
    if (editor) {
      const hit = locate(editor.getValue());
      if (hit) {
        // Write through CodeMirror without scrolling: Editor.replaceRange
        // scrolls the note to its own cursor, carrying the term (and its
        // card) out of view on every save.
        const cm = "cm" in editor ? editor.cm : null;
        if (cm instanceof EditorView) {
          cm.dispatch({ changes: { from: hit.from, to: hit.to, insert } });
        } else {
          editor.replaceRange(insert, editor.offsetToPos(hit.from), editor.offsetToPos(hit.to));
        }
      }
      return hit;
    }
    let hit: { from: number; to: number } | null = null;
    await this.app.vault.process(file, (text) => {
      hit = locate(text);
      return hit ? text.slice(0, hit.from) + insert + text.slice(hit.to) : text;
    });
    return hit;
  }

  /** The editor of an open tab showing `file`, if any. */
  private editorFor(file: TFile): Editor | null {
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find(
        (v): v is MarkdownView => v instanceof MarkdownView && v.file === file,
      );
    return view?.editor ?? null;
  }

  // — Hide `:`-prefixed definition sections from the visible reading-mode body —

  private hideDefinitionBlocks(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ) {
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    const af = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(af instanceof TFile)) return;
    const headings = this.app.metadataCache.getFileCache(af)?.headings ?? [];

    // A block is hidden when it falls inside a `:` heading's section: from that
    // heading until the next heading of equal-or-higher level (the same rule
    // resolveTarget uses to slice popup content), so sub-headings hide too.
    let hider: HeadingCache | null = null;
    for (const h of headings) {
      if (h.position.start.line > info.lineStart) break;
      if (hider && h.level <= hider.level) hider = null;
      if (!hider && h.heading.trimStart().startsWith(":")) hider = h;
    }
    if (!hider) return;

    // The post-processor also runs on popup cards, heading embeds and hover
    // previews, whose section info is relative to the rendered snippet, not the
    // file. Only hide when info.text really is this file.
    const lines = info.text.split("\n");
    const headingLine = hider.position.start.line;
    if (!lines[headingLine]?.includes(hider.heading)) return;

    // An `%% end %%` between the heading and this block closes the definition.
    for (let i = headingLine + 1; i <= info.lineStart; i++) {
      if (END_MARKER_RE.test(lines[i])) return;
    }
    el.addClass("nutshell-hidden-def");
  }
}

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  ChangeSpec,
  EditorState,
  Range,
  RangeSetBuilder,
  StateField,
  Text,
  TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap,
  placeholder,
} from "@codemirror/view";
import { Keymap, PaneType, finishRenderMath, loadMathJax, renderMath, setIcon } from "obsidian";
import { OpenTerm, termDecorations } from "./livePreview";
import { parseTerms } from "./terms";

/**
 * The editor inside a card: a small CodeMirror editor over the definition's
 * raw markdown. Unlike a plain text box it can draw things in place: images
 * (`![[image.png]]`, `![alt](url)`) show as the image, math (`$…$`, `$$…$$`)
 * is rendered, **bold**, *italic* and links are formatted (links open on
 * click), and terms inside the definition show as clickable terms, as in the
 * note. The raw markdown reappears when the cursor is on them. Everything
 * else stays raw text.
 */

// `![[target]]` / `![[target|300]]` (target: group 1), or `![alt|300](target)`
// (target: group 2). An optional `|width` or `|widthxheight` sets the size.
const IMAGE_RE = /!\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]|!\[[^\]\n]*\]\(<?([^)>\n]+?)>?\)/g;
const IMAGE_SIZE_RE = /\|(\d+)(?:x\d+)?\]/;
const MIN_IMAGE_WIDTH = 32;

/** Resolves an embed target to an image URL, or null when it isn't an image. */
export type ResolveImage = (target: string) => string | null;

/** The embed with its size set to `width` (Obsidian's `|width` syntax). */
function withWidth(embed: string, width: number): string {
  const wiki = /^!\[\[(.*?)(?:\|\d+(?:x\d+)?)?\]\]$/.exec(embed);
  if (wiki) return `![[${wiki[1]}|${width}]]`;
  const md = /^!\[(.*?)(?:\|\d+(?:x\d+)?)?\]\((.*)\)$/.exec(embed);
  return md ? `![${md[1]}|${width}](${md[2]})` : embed;
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly width: number | null,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.width === this.width;
  }

  toDOM(view: EditorView) {
    const wrap = createEl("span", { cls: "nutshell-editor-image" });
    const img = createEl("img", { attr: { src: this.src } });
    if (this.width) img.style.width = `${this.width}px`;
    // The image's height is only known once it loads.
    img.addEventListener("load", () => view.requestMeasure());

    // Drag the corner handle to resize; the new width is written into the
    // embed's `|width` when the drag ends.
    const handle = createEl("span", {
      cls: "nutshell-image-handle",
      attr: { "aria-label": "Drag to resize" },
    });
    handle.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      down.stopPropagation();
      handle.setPointerCapture(down.pointerId);
      const startWidth = img.getBoundingClientRect().width;
      const maxWidth = view.contentDOM.clientWidth;
      const resize = (move: PointerEvent) => {
        const width = startWidth + move.clientX - down.clientX;
        img.style.width = `${Math.max(MIN_IMAGE_WIDTH, Math.min(maxWidth, width))}px`;
      };
      const finish = () => {
        handle.removeEventListener("pointermove", resize);
        handle.removeEventListener("pointerup", finish);
        const at = view.posAtDOM(wrap);
        const width = Math.round(parseFloat(img.style.width));
        // The widget sits exactly where its embed starts.
        IMAGE_RE.lastIndex = at;
        const m = IMAGE_RE.exec(view.state.doc.toString());
        const resized = m && width > 0 ? withWidth(m[0], width) : null;
        if (m && m.index === at && resized && resized !== m[0]) {
          view.dispatch({
            changes: { from: at, to: at + m[0].length, insert: resized },
          });
        }
      };
      handle.addEventListener("pointermove", resize);
      handle.addEventListener("pointerup", finish);
    });

    wrap.append(img, handle);
    return wrap;
  }
}

function imageDecorations(view: EditorView, resolve: ResolveImage): DecorationSet {
  const { state } = view;
  const text = state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  IMAGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_RE.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    // Cursor or selection on the embed → show the raw link for editing.
    if (state.selection.ranges.some((r) => r.from <= to && r.to >= from)) continue;
    const src = resolve((m[1] ?? m[2]).trim());
    if (!src) continue;
    const size = IMAGE_SIZE_RE.exec(m[0]);
    const widget = new ImageWidget(src, size ? Number(size[1]) : null);
    builder.add(from, to, Decoration.replace({ widget }));
  }
  return builder.finish();
}

// Display math `$$…$$` (may span lines; group 1), or inline math `$…$` (group
// 2): it can't start or end with a space, and a digit right after the closing
// `$` means it was a price ("$5 and $6"), as in Obsidian.
const MATH_RE = /\$\$([\s\S]+?)\$\$|\$(?=[^\s$])((?:\\.|[^$\\\n])*?[^\s\\])\$(?!\d)/g;
// Code, where `$` is literal: fenced blocks, then inline code spans.
const FENCED_CODE_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE_RE = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;

class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.source === this.source && other.display === this.display;
  }

  toDOM(view: EditorView) {
    const wrap = createEl("span", {
      cls: ["nutshell-editor-math", ...(this.display ? ["is-display"] : [])],
    });
    // Obsidian loads MathJax on first use; until then show the source.
    wrap.setText(this.source);
    void loadMathJax().then(() => {
      wrap.replaceChildren(renderMath(this.source, this.display));
      void finishRenderMath();
      view.requestMeasure();
    });
    return wrap;
  }
}

/** `s` with every character but line breaks turned into a space (same length, so offsets still line up). */
function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/** `text` with code and terms blanked out: their contents are never formatting. */
function blankLiterals(text: string): string {
  let out = text.replace(FENCED_CODE_RE, blank).replace(INLINE_CODE_RE, blank);
  for (const t of parseTerms(out)) {
    out = out.slice(0, t.from) + blank(t.raw) + out.slice(t.to);
  }
  return out;
}

/**
 * Rendered math in place of `$…$` / `$$…$$`, except where the cursor or
 * selection touches it (raw for editing), inside code, or inside a term
 * (the term widget covers it).
 */
function mathDecorations(state: EditorState): DecorationSet {
  const text = blankLiterals(state.doc.toString());
  const builder = new RangeSetBuilder<Decoration>();
  MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_RE.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    if (text[from - 1] === "\\") {
      MATH_RE.lastIndex = from + 1; // an escaped `\$` is a literal dollar
      continue;
    }
    const source = (m[1] ?? m[2]).trim();
    if (!source) continue;
    if (state.selection.ranges.some((r) => r.from <= to && r.to >= from)) continue;
    builder.add(from, to, Decoration.replace({ widget: new MathWidget(source, m[1] !== undefined) }));
  }
  return builder.finish();
}

// A state field, not a view plugin: display math can span line breaks, and
// only state fields may replace those.
const math = StateField.define<DecorationSet>({
  create: mathDecorations,
  update: (deco, tr) => (tr.docChanged || tr.selection ? mathDecorations(tr.state) : deco),
  provide: (field) => EditorView.decorations.from(field),
});

// Links: `[[note]]` / `[[note|alias]]` (target 1, alias 2), `[text](<url>)`
// (3, 4) or `[text](url)` (5, 6). Not image embeds (`!`), not escaped `\[`.
const LINK_RE = /(?<![!\\])\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]|(?<![!\\])\[([^\]\n]+)\]\(<([^>\n]+)>\)|(?<![!\\])\[([^\]\n]+)\]\(([^)\s]+)\)/g;
// A URL with a scheme (https:, mailto:, obsidian:…) opens outside the vault.
export const EXTERNAL_LINK_RE = /^[a-z][a-z0-9+.-]*:/i;
// A bare web URL in the text (autolinked, as Obsidian does), minus trailing
// sentence punctuation.
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/g;
// Pasted text that is a single URL, which wraps a selection into a link.
const PASTED_URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
// Emphasis, outermost first; `_` only at word boundaries (so snake_case and
// URLs stay plain), as in Obsidian. Each regex captures the inner text.
const EMPHASIS: [RegExp, string][] = [
  [/\*\*\*(?=\S)([^\n]+?)(?<=\S)\*\*\*|(?<!\w)___(?=\S)([^\n]+?)(?<=\S)___(?!\w)/g, "nutshell-md-strong nutshell-md-em"],
  [/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*|(?<!\w)__(?=\S)([^\n]+?)(?<=\S)__(?!\w)/g, "nutshell-md-strong"],
  [/(?<![*\\])\*(?=[^\s*])([^\n*]+?)(?<=[^\s\\])\*(?!\*)|(?<![\w\\])_(?=[^\s_])([^\n_]+?)(?<=\S)_(?!\w)/g, "nutshell-md-em"],
];

/**
 * Bold, italic and links, drawn the way Obsidian's editor draws them: the
 * text is formatted and the markdown around it hidden, except where the
 * cursor or selection touches it (then the markers show, faint, for editing).
 * Code, terms, math and image embeds are left to their own handling.
 */
function formatDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  let text = blankLiterals(state.doc.toString())
    .replace(MATH_RE, blank)
    .replace(IMAGE_RE, blank);
  const decos: Range<Decoration>[] = [];
  const hide = Decoration.replace({});
  const faint = Decoration.mark({ class: "nutshell-md-formatting" });
  // Format [from, to) with `mark`; the markers around it are [start, from) and [to, end).
  const add = (start: number, from: number, to: number, end: number, mark: Decoration) => {
    const marker = state.selection.ranges.some((r) => r.from <= end && r.to >= start) ? faint : hide;
    decos.push(marker.range(start, from), mark.range(from, to), marker.range(to, end));
    // Formatting can nest inside the text, never inside the markers (or a link's URL).
    text = text.slice(0, start) + blank(text.slice(start, from)) + text.slice(from, to) + blank(text.slice(to, end)) + text.slice(end);
  };

  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    let from: number;
    let label: string;
    let href: string;
    if (m[1] !== undefined) {
      label = m[2] ?? m[1];
      href = m[1].trim();
      from = m[2] !== undefined ? end - 2 - m[2].length : start + 2;
    } else {
      label = m[3] ?? m[5];
      href = (m[4] ?? m[6]).trim();
      from = start + 1;
      // Markdown link targets are URL-encoded (`Note%20name.md`).
      if (!EXTERNAL_LINK_RE.test(href)) {
        try {
          href = decodeURIComponent(href);
        } catch {
          /* keep as written */
        }
      }
    }
    const cls = EXTERNAL_LINK_RE.test(href) ? "nutshell-md-link is-external" : "nutshell-md-link";
    // Only a formatted link (cursor elsewhere) is clickable; a raw one is being edited.
    const raw = state.selection.ranges.some((r) => r.from <= end && r.to >= start);
    add(start, from, from + label.length, end, Decoration.mark({ class: cls, attributes: raw ? {} : { "data-href": href } }));
  }
  // Bare URLs are links too; the URL is its own label, so nothing is hidden.
  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const raw = state.selection.ranges.some((r) => r.from <= end && r.to >= start);
    const attributes: Record<string, string> = raw ? {} : { "data-href": m[0] };
    decos.push(Decoration.mark({ class: "nutshell-md-link is-external", attributes }).range(start, end));
    text = text.slice(0, start) + blank(m[0]) + text.slice(end);
  }
  for (const [re, cls] of EMPHASIS) {
    const mark = Decoration.mark({ class: cls });
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const inner = m[1] ?? m[2];
      const width = (m[0].length - inner.length) / 2;
      add(m.index, m.index + width, m.index + m[0].length - width, m.index + m[0].length, mark);
    }
  }
  return Decoration.set(decos, true);
}

// A list line's prefix: indentation (1), bullet (2) or number (3) + delimiter
// (4), the space before the text (5), and an optional task box (6).
const LIST_RE = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
const QUOTE_RE = /^[ \t]*(?:>[ \t]?)+/;

/**
 * Renumber the numbered lists in the list block around lines `from`–`to` of
 * `doc`: each run of numbered items at one level counts up from its first
 * item; a shallower item or a bullet at that level restarts it. A block ends
 * at a blank line or an unindented non-list line. Returns the digit changes.
 */
function renumber(doc: Text, from: number, to: number, tabSize: number): ChangeSpec[] {
  const tab = " ".repeat(tabSize);
  const inBlock = (text: string) =>
    text.trim() !== "" && (LIST_RE.test(text) || /^[ \t]/.test(text));
  let start = from;
  let end = to;
  while (start > 1 && inBlock(doc.line(start - 1).text)) start--;
  while (end < doc.lines && inBlock(doc.line(end + 1).text)) end++;

  const nextAt = new Map<number, number>(); // indent width → next number there
  const changes: ChangeSpec[] = [];
  for (let n = start; n <= end; n++) {
    const line = doc.line(n);
    const item = LIST_RE.exec(line.text);
    if (!item) continue; // wrapped text inside an item
    const width = item[1].replace(/\t/g, tab).length;
    for (const level of [...nextAt.keys()]) if (level > width) nextAt.delete(level);
    if (item[3] === undefined) {
      nextAt.delete(width); // a bullet ends the numbered run at this level
      continue;
    }
    const expected = nextAt.get(width) ?? Number(item[3]);
    if (Number(item[3]) !== expected) {
      const at = line.from + item[1].length;
      changes.push({ from: at, to: at + item[3].length, insert: String(expected) });
    }
    nextAt.set(width, expected + 1);
  }
  return changes;
}

/** Apply `spec`, then renumber the lists around lines `from`–`to`: one undo step. */
function dispatchRenumbered(
  view: EditorView,
  spec: TransactionSpec,
  from: number,
  to: number,
) {
  const { state } = view;
  const doc = state.update(spec).state.doc;
  const changes = renumber(doc, from, Math.min(to, doc.lines), state.tabSize);
  view.dispatch(state.update(spec, { changes, sequential: true }));
}

/**
 * Tab / Shift+Tab, as in Obsidian's editor: on a list item (or every line of a
 * multi-line selection) indent or outdent the whole line by one level; a moved
 * numbered item restarts at 1 and the lists around it are renumbered. Tab in
 * ordinary text inserts a tab.
 */
function indentLines(view: EditorView, deeper: boolean): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from);
  const last = state.doc.lineAt(sel.to);
  if (deeper && first.number === last.number && !LIST_RE.test(first.text)) {
    view.dispatch(state.replaceSelection("\t"));
    return true;
  }
  const changes: ChangeSpec[] = [];
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n);
    if (!line.text.trim()) continue;
    const lead = /^[ \t]*/.exec(line.text)?.[0] ?? "";
    const cut = lead.startsWith("\t") ? 1 : Math.min(state.tabSize, lead.length);
    if (!deeper && cut === 0) continue;
    changes.push(
      deeper ? { from: line.from, insert: "\t" } : { from: line.from, to: line.from + cut },
    );
    const num = LIST_RE.exec(line.text)?.[3];
    if (num !== undefined) {
      const at = line.from + lead.length;
      changes.push({ from: at, to: at + num.length, insert: "1" });
    }
  }
  if (changes.length > 0) {
    dispatchRenumbered(
      view,
      { changes, userEvent: deeper ? "input.indent" : "delete.dedent" },
      first.number,
      last.number,
    );
  }
  return true;
}

/**
 * Return in a list item or quote, as in Obsidian's editor: start the next item
 * (next number, same bullet, fresh task box) and renumber the list; on an
 * empty item, end the list, or move a nested item out a level. Anywhere else,
 * Return behaves normally.
 */
function continueMarkup(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length > 1 || !sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const item = LIST_RE.exec(line.text);
  const prefix = item?.[0] ?? QUOTE_RE.exec(line.text)?.[0];
  if (!prefix || sel.head < line.from + prefix.length) return false;

  if (line.text.slice(prefix.length).trim() === "") {
    // Empty nested item: out one level. Otherwise: drop the marker.
    if (item && item[1] !== "") return indentLines(view, false);
    view.dispatch({
      changes: { from: line.from, to: line.to },
      selection: { anchor: line.from },
    });
    return true;
  }

  if (!item) {
    view.dispatch(state.replaceSelection(`\n${prefix}`));
    return true;
  }
  const [, indent, bullet, num, delim, space, task] = item;
  const insert = `\n${indent}${bullet ?? `${Number(num) + 1}${delim}`}${space}${task ? "[ ] " : ""}`;
  // Splitting mid-item: the moved text starts right after the new marker.
  const rest = line.text.slice(sel.head - line.from);
  const skip = rest.length - rest.trimStart().length;
  dispatchRenumbered(
    view,
    {
      changes: { from: sel.head, to: sel.head + skip, insert },
      selection: { anchor: sel.head + insert.length },
      scrollIntoView: true,
      userEvent: "input",
    },
    line.number,
    line.number + 1,
  );
  return true;
}

/**
 * Hanging indent for list lines, as in Obsidian's editor: each list line is
 * indented by the width of its prefix and its first line pulled back by the
 * same amount, so wrapped lines line up under the item's text instead of
 * returning to the left edge. Prefix widths are measured with a hidden span
 * inside the editor, so they use exactly the editor's font.
 */
function listDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const tab = " ".repeat(state.tabSize);
  const widths = new Map<string, number>();
  const probe = document.createElement("span");
  probe.className = "nutshell-measure";
  view.dom.append(probe);
  const builder = new RangeSetBuilder<Decoration>();
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const m = LIST_RE.exec(line.text);
    if (!m) continue;
    const prefix = m[0].replace(/\t/g, tab);
    let width = widths.get(prefix);
    if (width === undefined) {
      probe.textContent = prefix;
      width = probe.getBoundingClientRect().width;
      widths.set(prefix, width);
    }
    // Zero when there's no layout yet: fall back to character widths.
    const indent = width > 0 ? `${width}px` : `${prefix.length}ch`;
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        attributes: {
          style: `padding-inline-start: ${indent}; text-indent: -${indent}`,
        },
      }),
    );
  }
  probe.remove();
  return builder.finish();
}

/**
 * Save image files (pasted or dropped) and embed each one: at `at` when given
 * (a drop point), otherwise at the cursor. Saving is async, so insertion
 * happens once each file is stored.
 */
async function insertImages(
  view: EditorView,
  images: File[],
  save: (file: File, dropped: boolean) => Promise<string | null>,
  at?: number,
) {
  let pos = at;
  for (const image of images) {
    const embed = await save(image, at !== undefined);
    if (!embed || !view.dom.isConnected) continue;
    if (pos === undefined) {
      view.dispatch(view.state.replaceSelection(embed));
      continue;
    }
    pos = Math.min(pos, view.state.doc.length);
    view.dispatch({
      changes: { from: pos, insert: embed },
      selection: { anchor: pos + embed.length },
    });
    pos += embed.length;
  }
}

function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

// A closed fenced code block with a language (group 2), from its opening
// fence line to its closing one. An unclosed block (still being typed) stays raw.
const CODE_BLOCK_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+-]+)[^\n]*\n(?:[^\n]*\n)*? {0,3}\1[ \t]*$/gm;

/** Renders a code block's markdown into `el` (e.g. a plugin's ```wave plot); returns the cleanup. */
export interface CodeBlockRenderer {
  canRender: (language: string) => boolean;
  render: (markdown: string, el: HTMLElement) => () => void;
}

/**
 * A code block a plugin renders (```wave, ```mermaid…), drawn as its output, as
 * in Obsidian's editor. Events inside belong to the output (sliders, buttons),
 * not the editor; the `</>` button, or arrowing into the block, shows its
 * source (with the output kept in view in the card's preview pane).
 */
class CodeBlockWidget extends WidgetType {
  private static cleanups = new WeakMap<HTMLElement, () => void>();

  constructor(
    readonly markdown: string,
    readonly renderer: CodeBlockRenderer,
  ) {
    super();
  }

  // Same source → keep the DOM, so a plot keeps its slider positions while you type elsewhere.
  eq(other: CodeBlockWidget) {
    return other.markdown === this.markdown;
  }

  toDOM(view: EditorView) {
    const wrap = createDiv({ cls: "nutshell-editor-block" });
    const output = wrap.createDiv();
    const edit = wrap.createEl("button", {
      cls: "clickable-icon nutshell-editor-block-edit",
      attr: { "aria-label": "Edit this block" },
    });
    setIcon(edit, "code-2");
    edit.addEventListener("click", () => {
      const at = view.posAtDOM(wrap);
      // Cursor at the end of the opening fence line: the block shows as source.
      view.dispatch({ selection: { anchor: view.state.doc.lineAt(at).to }, scrollIntoView: true });
      view.focus();
    });
    CodeBlockWidget.cleanups.set(wrap, this.renderer.render(this.markdown, output));
    return wrap;
  }

  ignoreEvent() {
    return true;
  }

  destroy(dom: HTMLElement) {
    CodeBlockWidget.cleanups.get(dom)?.();
  }
}

/** The plugin code blocks in `state`, and whether the cursor or selection touches each one. */
function renderedBlocks(
  state: EditorState,
  renderer: CodeBlockRenderer,
): { from: number; to: number; markdown: string; touched: boolean }[] {
  const text = state.doc.toString();
  const blocks: { from: number; to: number; markdown: string; touched: boolean }[] = [];
  CODE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_BLOCK_RE.exec(text))) {
    if (!renderer.canRender(m[2])) continue;
    const from = m.index;
    const to = from + m[0].length;
    const touched = state.selection.ranges.some((r) => r.from <= to && r.to >= from);
    blocks.push({ from, to, markdown: m[0], touched });
  }
  return blocks;
}

/** Rendered plugin code blocks, except where the cursor or selection touches one (source for editing). */
function codeBlockDecorations(state: EditorState, renderer: CodeBlockRenderer): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const b of renderedBlocks(state, renderer)) {
    if (b.touched) continue;
    const widget = new CodeBlockWidget(b.markdown, renderer);
    builder.add(b.from, b.to, Decoration.replace({ widget, block: true }));
  }
  return builder.finish();
}

/**
 * Up/Down into a rendered block's source. The block is one widget, so the
 * default vertical move would jump right over it: from the line above, land at
 * the end of the opening fence; from the line below, at the closing fence.
 */
function enterCodeBlock(view: EditorView, renderer: CodeBlockRenderer, forward: boolean): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const next = view.moveVertically(sel, forward).head;
  const { doc } = view.state;
  for (const b of renderedBlocks(view.state, renderer)) {
    if (b.touched) continue;
    const skipped = forward ? sel.head < b.from && next > b.to : sel.head > b.to && next < b.from;
    if (!skipped) continue;
    const anchor = forward ? doc.lineAt(b.from).to : doc.lineAt(b.to).from;
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    return true;
  }
  return false;
}

// How long typing in a block's source waits before the preview is redrawn.
const PREVIEW_DELAY_MS = 250;

export function createCardEditor(
  parent: HTMLElement,
  doc: string,
  options: {
    onChange: (text: string) => void;
    resolveImage: ResolveImage;
    terms: { sourcePath: string; open: OpenTerm };
    /** Save a pasted or dropped image file (dropped files keep their name); returns the embed markdown (null on failure). */
    saveImage: (file: File, dropped: boolean) => Promise<string | null>;
    /** Markdown for dropped text that names a vault file (an Obsidian file drag); null otherwise. */
    embedDropped: (text: string) => string | null;
    /** Open a link's target (`newLeaf` from the click's modifier keys, as in a note). */
    openLink: (href: string, newLeaf: PaneType | boolean) => void;
    /** Renders plugin code blocks (```wave…) in place. */
    codeBlocks: CodeBlockRenderer;
  },
): EditorView {
  // A state field, not a view plugin: a block replaces whole lines.
  const codeBlocks = StateField.define<DecorationSet>({
    create: (state) => codeBlockDecorations(state, options.codeBlocks),
    update: (deco, tr) =>
      tr.docChanged || tr.selection ? codeBlockDecorations(tr.state, options.codeBlocks) : deco,
    provide: (field) => EditorView.decorations.from(field),
  });

  // While a block's source is being edited, its output shows in this pane,
  // pinned to the bottom of the card (styles.css), so it stays in view however
  // long the source is. It sits outside the editor: CodeMirror never redraws
  // it, and clicks on it (sliders) don't move the cursor.
  const pane = createDiv({ cls: "nutshell-block-preview" });
  pane.hidden = true;
  const blockPreview = ViewPlugin.fromClass(
    class {
      current: string | null = null; // the markdown shown
      out: HTMLElement | null = null;
      cleanup: (() => void) | null = null;
      timer: number | null = null;

      constructor(view: EditorView) {
        this.sync(view.state, false);
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet) this.sync(u.state, u.docChanged);
      }

      sync(state: EditorState, typing: boolean) {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
        const md = renderedBlocks(state, options.codeBlocks).find((b) => b.touched)?.markdown ?? null;
        // Unchanged source: keep the plot (and its slider positions).
        if (md === this.current) return;
        if (md === null) {
          this.clear();
        } else if (typing && this.current !== null) {
          this.timer = window.setTimeout(() => {
            this.timer = null;
            this.show(md);
          }, PREVIEW_DELAY_MS);
        } else {
          this.show(md); // just entered the block: show it right away
        }
      }

      // Render the new output before removing the old one, so it doesn't flash.
      show(md: string) {
        const out = pane.createDiv();
        const cleanup = options.codeBlocks.render(md, out);
        this.clear();
        this.out = out;
        this.cleanup = cleanup;
        this.current = md;
        pane.hidden = false;
      }

      clear() {
        this.cleanup?.();
        this.out?.remove();
        this.out = this.cleanup = this.current = null;
        pane.hidden = true;
      }

      destroy() {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.clear();
        pane.remove();
      }
    },
  );
  const images = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = imageDecorations(view, options.resolveImage);
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet) {
          this.decorations = imageDecorations(u.view, options.resolveImage);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const terms = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.focusChanged) {
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView) {
        const whole = [{ from: 0, to: view.state.doc.length }];
        return termDecorations(view, whole, options.terms.sourcePath, options.terms.open);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const formatting = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = formatDecorations(view);
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet) this.decorations = formatDecorations(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const lists = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = listDecorations(view);
      }

      update(u: ViewUpdate) {
        if (u.docChanged) this.decorations = listDecorations(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([
          { key: "Enter", run: continueMarkup },
          {
            key: "Tab",
            run: (view) => indentLines(view, true),
            shift: (view) => indentLines(view, false),
          },
          { key: "ArrowDown", run: (v) => enterCodeBlock(v, options.codeBlocks, true) },
          { key: "ArrowUp", run: (v) => enterCodeBlock(v, options.codeBlocks, false) },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        placeholder("Write the definition…"),
        EditorView.editorAttributes.of({ class: "nutshell-editor" }),
        // Pasted or dropped image files are saved as attachments and embedded;
        // files dragged in from Obsidian (file list, search) are linked.
        EditorView.domEventHandlers({
          // A formatted link opens on click, as in Obsidian's editor; with
          // the cursor on it, it shows raw and clicks just place the cursor.
          mousedown(event) {
            const target = event.target as Element | null;
            const link = target?.closest?.(".nutshell-md-link[data-href]");
            if (!link || event.button !== 0) return false;
            event.preventDefault();
            options.openLink(link.getAttribute("data-href") ?? "", Keymap.isModEvent(event));
            return true;
          },
          paste(event, view) {
            const images = imageFiles(event.clipboardData);
            if (images.length > 0) {
              event.preventDefault();
              void insertImages(view, images, options.saveImage);
              return true;
            }
            // Pasting a URL over selected text links the text, as in a note.
            const url = event.clipboardData?.getData("text/plain").trim() ?? "";
            const sel = view.state.selection.main;
            const label = view.state.sliceDoc(sel.from, sel.to);
            if (sel.empty || label.includes("\n") || !PASTED_URL_RE.test(url)) return false;
            event.preventDefault();
            const link = `[${label}](${/[\s()<>]/.test(url) ? `<${url}>` : url})`;
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: link },
              selection: { anchor: sel.from + link.length },
              userEvent: "input.paste",
            });
            return true;
          },
          dragover(event) {
            // Accept file drops (the browser refuses them by default).
            if (!event.dataTransfer?.types.includes("Files")) return false;
            event.preventDefault();
            return true;
          },
          drop(event, view) {
            const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (at === null) return false;
            const images = imageFiles(event.dataTransfer);
            const embed =
              images.length > 0
                ? null
                : options.embedDropped(event.dataTransfer?.getData("text/plain") ?? "");
            if (images.length === 0 && !embed) return false;
            // Keep Obsidian from also handling the drop (e.g. importing the file).
            event.preventDefault();
            event.stopPropagation();
            view.focus();
            if (embed) {
              view.dispatch({
                changes: { from: at, insert: embed },
                selection: { anchor: at + embed.length },
              });
            } else {
              void insertImages(view, images, options.saveImage, at);
            }
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) options.onChange(u.state.doc.toString());
        }),
        terms, // before images: a term hides any image inside its definition
        images,
        math,
        codeBlocks,
        blockPreview,
        // Scrolling the cursor into view keeps it above the pinned preview:
        // reserve the space from the pane's top to the card's bottom edge
        // (the pane's height plus the card's bottom padding).
        EditorView.scrollMargins.of(() => {
          if (pane.hidden) return null;
          const card = pane.closest(".nutshell-popup");
          const paneTop = pane.getBoundingClientRect().top;
          return { bottom: card ? card.getBoundingClientRect().bottom - paneTop : pane.offsetHeight };
        }),
        formatting,
        lists,
      ],
    }),
  });
  parent.appendChild(pane); // right after the editor
  return view;
}

import { syntaxTree } from "@codemirror/language";
import { Prec, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { parseTerms } from "./terms";

/**
 * Live Preview support: renders every term (`[:label]%% … %%`, bare
 * `[:label]`, or `[:label](<#Heading>)`) as a clickable `.nutshell-trigger`
 * that opens the same popup card as reading mode, so inline definitions stay
 * hidden while writing. The raw markdown reappears only while the editor has
 * focus and the cursor/selection touches the term, so it stays editable.
 * Source mode is left untouched.
 */

/**
 * `term` is the link target for link terms, or the document offset of an
 * inline term (read at click time, so it is current even after edits).
 */
export type OpenTerm = (
  trigger: HTMLElement,
  sourcePath: string,
  term: string | number,
) => void;

// Obsidian syntax-tree node names for code and math, where terms are literal.
const LITERAL_NODE_RE = /code|math/;

class TermWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly target: string | null,
    readonly sourcePath: string,
    readonly open: OpenTerm,
  ) {
    super();
  }

  // Inline terms compare by label only, so CodeMirror keeps the same DOM node
  // while the card writes the definition (the stored text changes, the term
  // doesn't) and the open card stays anchored to it.
  eq(other: TermWidget) {
    return (
      other.label === this.label &&
      other.target === this.target &&
      other.sourcePath === this.sourcePath
    );
  }

  toDOM(view: EditorView) {
    const el = createSpan({ cls: "nutshell-trigger", text: this.label });
    // Keep the editor from moving the cursor into the term (which would
    // reveal the raw markdown) when it is clicked.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.open(el, this.sourcePath, this.target ?? view.posAtDOM(el));
    });
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * Replace each term in `ranges` (whole lines) with a clickable term widget,
 * except where the focused editor's cursor/selection touches it (raw markdown
 * for editing) or `isLiteral(pos)` says it's inside code/math. Shared by Live
 * Preview and the card editor.
 */
export function termDecorations(
  view: EditorView,
  ranges: readonly { from: number; to: number }[],
  sourcePath: string,
  open: OpenTerm,
  isLiteral: (pos: number) => boolean = () => false,
): DecorationSet {
  const { state } = view;
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of ranges) {
    for (const term of parseTerms(state.sliceDoc(from, to), from)) {
      const touched =
        view.hasFocus &&
        state.selection.ranges.some(
          (r) => r.from <= term.to && r.to >= term.from,
        );
      if (touched || isLiteral(term.from + 1)) continue;
      const widget = new TermWidget(term.label, term.target, sourcePath, open);
      builder.add(term.from, term.to, Decoration.replace({ widget }));
    }
  }
  return builder.finish();
}

function buildDecorations(view: EditorView, open: OpenTerm): DecorationSet {
  const { state } = view;
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;

  // Parse whole lines, not the raw visible ranges: Obsidian's own widgets (an
  // image embed inside a definition, say) split one line into several visible
  // ranges, which would cut a term in half. Terms never span lines.
  const lines: { from: number; to: number }[] = [];
  let parsedTo = -1; // end of the last line parsed
  for (const range of view.visibleRanges) {
    const from = Math.max(state.doc.lineAt(range.from).from, parsedTo + 1);
    const to = state.doc.lineAt(range.to).to;
    if (from > to) continue;
    parsedTo = to;
    lines.push({ from, to });
  }
  const tree = syntaxTree(state);
  return termDecorations(
    view,
    lines,
    state.field(editorInfoField, false)?.file?.path ?? "",
    open,
    (pos) => LITERAL_NODE_RE.test(tree.resolveInner(pos, 1).name),
  );
}

export function nutshellLivePreview(open: OpenTerm) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, open);
      }

      update(u: ViewUpdate) {
        const modeChanged =
          u.startState.field(editorLivePreviewField, false) !==
          u.state.field(editorLivePreviewField, false);
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          modeChanged
        ) {
          this.decorations = buildDecorations(u.view, open);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  // Take precedence over Obsidian's own link/comment rendering for the range.
  return Prec.highest(plugin);
}

/**
 * Term syntax, shared by reading view, Live Preview and the create command.
 *
 * - Inline term: `[:label]%% definition %%`. The definition is stored in an
 *   Obsidian comment right after the label, so it never shows in reading view.
 *   A bare `[:label]` is an inline term with no definition yet.
 * - Link term: `[:label](<#Heading>)` or `[:label](target)`. The definition is
 *   the target heading's section.
 *
 * Inline definitions are kept on one line so the comment stays inside its
 * paragraph: `%` is stored as `%25` and a line break as `%0A`, so the stored
 * text can never contain `%%` or a newline.
 */
const TERM_RE = /\[:([^\]\n]+)\](?:\((?:<([^>\n]*)>|([^)\s]+))\)|%%(.*?)%%)?/g;

// Display math `$$…$$` (may span lines; group 1), or inline math `$…$` (group
// 2): it can't start or end with a space, and a digit right after the closing
// `$` means it was a price ("$5 and $6"), as in Obsidian.
export const MATH_RE = /\$\$([\s\S]+?)\$\$|\$(?=[^\s$])((?:\\.|[^$\\\n])*?[^\s\\])\$(?!\d)/g;
// Code, where `$` and `[:…]` are literal: fenced blocks, then inline code spans.
const FENCED_CODE_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE_RE = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;

export interface Term {
  from: number; // offset of `[` in the parsed text (plus `base`)
  to: number;
  raw: string; // the full markdown of the term
  label: string;
  target: string | null; // link terms only
  definition: string; // inline terms only (decoded); "" for link terms
}

/** `s` with every character but line breaks turned into a space (same length, so offsets still line up). */
export function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/** `text` with code blocks and code spans blanked out. */
export function blankCode(text: string): string {
  return text.replace(FENCED_CODE_RE, blank).replace(INLINE_CODE_RE, blank);
}

/**
 * Drop the blank lines around a definition and its trailing whitespace, but
 * keep the indentation of its first line (it can be meaningful: indented code).
 */
export function trimBlankLines(s: string): string {
  return s.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

export function parseTerms(text: string, base = 0): Term[] {
  const terms: Term[] = [];
  TERM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERM_RE.exec(text))) {
    const target = m[2] ?? m[3] ?? null;
    terms.push({
      from: base + m.index,
      to: base + m.index + m[0].length,
      raw: m[0],
      label: m[1].replace(/^\s+/, ""),
      target,
      definition:
        target === null
          ? trimBlankLines(
              // inlineTerm pads the stored text with one space on each side.
              (m[4] ?? "").replace(/^ /, "").replace(/ $/, "").replace(/%0A/g, "\n").replace(/%25/g, "%"),
            )
          : "",
    });
  }
  return terms;
}

/**
 * The terms of `text` that render as terms: not inside code or math, where
 * `[:label]` is literal text.
 */
export function renderedTerms(text: string, base = 0): Term[] {
  const code = blankCode(text);
  const terms = parseTerms(text).filter((t) => code[t.from] === "[");
  // Math is found with the surviving terms blanked, so a `$` inside a hidden
  // definition never pairs with one in the visible text.
  let masked = code;
  for (const t of terms) masked = masked.slice(0, t.from) + blank(t.raw) + masked.slice(t.to);
  const math: { from: number; to: number }[] = [];
  MATH_RE.lastIndex = 0;
  for (let m = MATH_RE.exec(masked); m; m = MATH_RE.exec(masked)) {
    if (masked[m.index - 1] === "\\") {
      MATH_RE.lastIndex = m.index + 1; // an escaped `\$` is a literal dollar
      continue;
    }
    math.push({ from: m.index, to: m.index + m[0].length });
  }
  return terms
    .filter((t) => !math.some((r) => r.from <= t.from && t.from < r.to))
    .map((t) => ({ ...t, from: t.from + base, to: t.to + base }));
}

/** Markdown for an inline term; an empty definition gives a bare `[:label]`. */
export function inlineTerm(label: string, definition: string): string {
  const stored = definition.replace(/%/g, "%25").replace(/\n/g, "%0A");
  return stored ? `[:${label}]%% ${stored} %%` : `[:${label}]`;
}

/**
 * The term whose markdown is `ref.raw`, found again in `text`: the one still
 * at offset `ref.at`, else the only one with that markdown. Null when it is
 * gone or ambiguous (identical terms that moved): better no write than a write
 * to the wrong term.
 */
export function findTerm(
  text: string,
  ref: { raw: string; at: number },
): Term | null {
  const same = parseTerms(text).filter((t) => t.raw === ref.raw);
  return same.find((t) => t.from === ref.at) ?? (same.length === 1 ? same[0] : null);
}

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

export interface Term {
  from: number; // offset of `[` in the parsed text (plus `base`)
  to: number;
  raw: string; // the full markdown of the term
  label: string;
  target: string | null; // link terms only
  definition: string; // inline terms only (decoded); "" for link terms
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
          ? (m[4] ?? "").trim().replace(/%0A/g, "\n").replace(/%25/g, "%")
          : "",
    });
  }
  return terms;
}

/** Markdown for an inline term; an empty definition gives a bare `[:label]`. */
export function inlineTerm(label: string, definition: string): string {
  const stored = definition.replace(/%/g, "%25").replace(/\n/g, "%0A");
  return stored ? `[:${label}]%% ${stored} %%` : `[:${label}]`;
}

/**
 * The term whose markdown is `ref.raw`, nearest to offset `ref.at` (the same
 * term text can appear more than once).
 */
export function findTerm(
  text: string,
  ref: { raw: string; at: number },
): Term | null {
  let best: Term | null = null;
  for (const t of parseTerms(text)) {
    if (
      t.raw === ref.raw &&
      (!best || Math.abs(t.from - ref.at) < Math.abs(best.from - ref.at))
    ) {
      best = t;
    }
  }
  return best;
}

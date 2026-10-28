/**
 * Heading definitions: finding the section a link term like
 * `[:beta](<#Beta Distribution>)` opens, in a note's markdown.
 */

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;
// A line containing only `%% end %%` (an Obsidian comment, invisible in reading
// view) closes a definition early. Without it, a definition runs to the next
// heading of equal-or-higher level.
export const END_MARKER_RE = /^\s*%%\s*end\s*%%\s*$/i;

/** Forgiving heading match: drop a leading colon, lowercase, trim. */
export function normalizeHeading(s: string): string {
  return s.replace(/^:\s*/, "").trim().toLowerCase();
}

/**
 * Locate the body of heading `want` (normalized) in `text` as character offsets
 * [from, to): `from` is the end of the heading line, `to` is just before the
 * line that closes it (`%% end %%` or the next heading of equal-or-higher
 * level), or the end of the text. Headings inside code fences are ignored.
 *
 * Term links name hidden definitions without their colon, so a hidden
 * (`## :Beta`) heading wins over a visible `## Beta`. `ambiguous` is set when
 * several headings of the winning kind match; the first one is returned.
 */
export function findSection(
  text: string,
  want: string,
): { from: number; to: number; ambiguous: boolean } | null {
  // Lines outside code fences, with their heading level/name (null: not a heading).
  const lines: { start: number; text: string; level: number; name: string | null }[] = [];
  let offset = 0;
  let fence: string | null = null;
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
    lines.push({ start, text: line, level: h ? h[1].length : 0, name: h ? (h[2] ?? "") : null });
  }

  const matches = lines.filter((l) => l.name !== null && normalizeHeading(l.name) === want);
  const hidden = matches.filter((l) => (l.name ?? "").trimStart().startsWith(":"));
  const pick = hidden.length > 0 ? hidden : matches;
  if (pick.length === 0) return null;
  const open = pick[0];
  const from = open.start + open.text.length;
  const ambiguous = pick.length > 1;
  for (const l of lines) {
    if (l.start <= open.start) continue;
    if (END_MARKER_RE.test(l.text) || (l.name !== null && l.level <= open.level)) {
      return { from, to: l.start - 1, ambiguous };
    }
  }
  return { from, to: text.length, ambiguous };
}

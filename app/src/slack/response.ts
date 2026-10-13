const CHROME_TEXT =
  /\b(add a follow-up|composer\b|run everything|shift\+tab|plan mode|esc to cancel|esc to interrupt|tokens? left|context left|accept all|reject all|keep all|undo all)\b/i;
/** Collapsed tool output and expander affordances Cursor shows inline. */
const COLLAPSED_OUTPUT =
  /(\d+\s+)?(more\s+)?(output\s+)?lines?\s+hidden|ctrl\+o\b|to expand|^\s*show (less|more)\s*$/i;
const PATH_FOOTER = /^\s*[~/.][^\n]*\s+[·•]\s+\S+/u;
const BOX = /^[\s▄▀█─━═_\u2500-\u257f]+$/u;
const PROMPT_RULE = /^\s*[>❯›▶→]\s*/u;

/** Symbols/keywords that mark a line as code rather than an assistant sentence. */
const CODE_SIGNAL =
  /[;{}]|=>|\)\s*[{;]$|\b(const|let|var|function|return|import|export|await|async|class|interface)\b|\w\.\w+\(/;
/**
 * A command line, anchored to the start. Prose that merely mentions `&&` in a
 * sentence is not a command, so matching anywhere would eat real replies.
 */
const SHELL_COMMAND = /^(\$|❯|&&|\|\|)\s/u;

function newSuffix(previous: string, current: string): string {
  if (current.startsWith(previous)) return current.slice(previous.length).replace(/^\n/u, "");
  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  const limit = Math.min(previousLines.length, currentLines.length);
  for (let overlap = limit; overlap > 0; overlap -= 1) {
    if (previousLines.slice(-overlap).join("\n") === currentLines.slice(0, overlap).join("\n")) {
      return currentLines.slice(overlap).join("\n");
    }
  }
  return current;
}

/**
 * Best-effort terminal-to-response extraction.
 *
 * Herdr exposes rendered terminal text, not structured assistant messages.
 *
 * With a baseline we know exactly which region is new, so the whole of it is
 * returned in order: that is the turn as it happened. Picking only the trailing
 * prose out of it used to look tidier and was actively wrong — a reply that ends
 * in a bullet list or a file reference had everything above its last paragraph
 * thrown away.
 *
 * Without a baseline the "new region" is the entire scrollback, which is nobody's
 * reply. There the trailing prose block is the best available guess.
 */
export function extractAgentResponse(raw: string, baseline = ""): string {
  if (baseline) {
    const delta = clean(newSuffix(baseline.trimEnd(), raw.trimEnd()));
    if (delta) return delta;
  }
  const fallback = clean(raw);
  return trailingProse(fallback) || fallback;
}

/** A line that reads like a shell command, a comment, or source code. */
function looksLikeCode(trimmed: string): boolean {
  if (!trimmed) return false;
  if (SHELL_COMMAND.test(trimmed)) return true; // shell command, possibly chained
  if (/^\/\//u.test(trimmed)) return true; // comment
  if (/^[)}\];{(]+$/u.test(trimmed)) return true; // punctuation-only
  if (/^[+\-]\s?\S/u.test(trimmed) && CODE_SIGNAL.test(trimmed)) return true; // diff of code
  if (CODE_SIGNAL.test(trimmed) && !/[.!?)]$/u.test(trimmed)) return true; // bare code line
  return false;
}

/**
 * Return the assistant's final message, walking up from the bottom until a
 * code/command boundary. A command's own output sits between that boundary and
 * the reply and reads like prose, so once we stop at a command we drop its
 * output region — everything up to and including the first blank line. When the
 * command is followed directly by prose (no blank) there is no output to drop.
 */
function trailingProse(cleaned: string): string {
  if (!cleaned) return "";
  const lines = cleaned.split("\n");
  const collected: string[] = [];
  let stoppedAtCode = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      if (collected.length > 0) collected.unshift(line);
      continue;
    }
    if (looksLikeCode(trimmed)) {
      stoppedAtCode = true;
      break;
    }
    collected.unshift(line);
  }
  if (stoppedAtCode) {
    const firstBlank = collected.findIndex((line) => line.trim() === "");
    if (firstBlank !== -1) collected.splice(0, firstBlank + 1);
  }
  while (collected[0]?.trim() === "") collected.shift();
  while (collected.at(-1)?.trim() === "") collected.pop();
  return collected.join("\n").trim();
}

/**
 * Whether an extraction is worth recording as a turn.
 *
 * Scrollback extraction is best-effort, so it sometimes yields a spinner frame
 * or a stray fragment. Those are fine to show transiently on the card but must
 * not be persisted into history, where they are permanent noise.
 */
export function isSubstantiveResponse(response: string): boolean {
  const stripped = response.replace(/[\u2800-\u28ff\u2500-\u257f▄▀█]/gu, " ").trim();
  if (stripped.length < 12) return false;
  const words = stripped.split(/\s+/u).filter((word) => /[A-Za-z0-9]/u.test(word));
  return words.length >= 3;
}

function clean(input: string): string {
  const lines = input
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (BOX.test(trimmed)) return false;
      if (CHROME_TEXT.test(trimmed)) return false;
      if (COLLAPSED_OUTPUT.test(trimmed)) return false;
      if (PATH_FOOTER.test(trimmed)) return false;
      if (PROMPT_RULE.test(trimmed) && trimmed.length < 100) return false;
      return true;
    });

  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();

  return lines.join("\n").trim();
}

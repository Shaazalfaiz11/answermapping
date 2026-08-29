import type { AnswerBlock, Question } from "./types";

/**
 * Label normalisation and deterministic matching.
 *
 * Most answers carry a written label, and a label match is exact evidence - far
 * better than anything a model infers. So we resolve those in code first and
 * only spend a model call on the blocks that are genuinely ambiguous.
 */

const ROMAN = /^[ivxl]+$/i;

/** Canonical key for a question: "11a", "5ii", "3". */
export function questionKey(number: string, subPart: string): string {
  return `${number.trim()}${subPart.trim().toLowerCase()}`;
}

export interface ParsedLabel {
  number: string;
  subPart: string;
  key: string;
}

/**
 * Parse a written label into its parts. Handles the forms students actually
 * write: "Q3", "3.", "Ans 11(a)", "11 a)", "5(ii)", "Answer to 7".
 */
export function parseLabel(raw: string | null | undefined): ParsedLabel | null {
  if (!raw) return null;

  const cleaned = raw
    .trim()
    .toLowerCase()
    // Drop answer/question prefixes and any joining words.
    .replace(/^(?:ans(?:wer)?|sol(?:ution)?|q(?:uestion)?|no|number)\b/g, " ")
    .replace(/\bto\b/g, " ")
    .replace(/[.:\-_#]/g, " ")
    .trim();

  const match = cleaned.match(
    /(\d{1,3})\s*(?:\(\s*([a-z]{1,4})\s*\)|\s+([a-z]{1,4})\b|([a-z]{1,2})\b)?/,
  );
  if (!match) return null;

  const number = match[1];
  const rawSub = (match[2] ?? match[3] ?? match[4] ?? "").trim();

  // Guard against swallowing a word that merely follows the number, e.g. the
  // "the" in "3 the heart pumps". Real sub-parts are a letter or a roman numeral.
  const subPart =
    rawSub && (rawSub.length === 1 || ROMAN.test(rawSub)) ? rawSub : "";

  return { number, subPart, key: questionKey(number, subPart) };
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "is", "are", "was", "were",
  "for", "on", "at", "by", "with", "that", "this", "it", "its", "as", "from",
  "be", "been", "which", "what", "how", "why", "when", "where", "explain",
  "describe", "state", "give", "name", "draw", "label", "show", "write", "list",
  "define", "calculate", "briefly", "one", "two", "three", "your", "you",
]);

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/**
 * Containment similarity: what share of the question's distinctive words the
 * answer uses. Cheap, dependency-free, and good enough to rank candidates - the
 * model makes the actual call.
 */
export function similarity(questionText: string, answerText: string): number {
  const q = contentTokens(questionText);
  const a = contentTokens(answerText);
  if (q.size === 0 || a.size === 0) return 0;

  let shared = 0;
  for (const token of q) if (a.has(token)) shared++;
  return shared / q.size;
}

export interface LabelMatchResult {
  /** questionId -> block ids, in page then line order. */
  matched: Map<string, string[]>;
  /** Blocks with no usable label, to be resolved by content. */
  unlabelled: AnswerBlock[];
  /** Blocks whose written label matches no question on the paper. */
  strayLabelled: AnswerBlock[];
}

/**
 * Resolve every block whose written label points at a real question.
 * Falls back to the bare number when a student omits the sub-part but only one
 * sub-part exists, which is the common "wrote 11 instead of 11(a)" case.
 */
export function matchByLabel(
  questions: Question[],
  blocks: AnswerBlock[],
): LabelMatchResult {
  const byKey = new Map<string, Question>();
  const byNumber = new Map<string, Question[]>();

  for (const q of questions) {
    byKey.set(questionKey(q.number, q.subPart), q);
    const list = byNumber.get(q.number) ?? [];
    list.push(q);
    byNumber.set(q.number, list);
  }

  const matched = new Map<string, string[]>();
  const unlabelled: AnswerBlock[] = [];
  const strayLabelled: AnswerBlock[] = [];

  const ordered = [...blocks].sort(
    (a, b) => a.pageIndex - b.pageIndex || a.startLine - b.startLine,
  );

  for (const block of ordered) {
    const parsed = parseLabel(block.writtenLabel);
    if (!parsed) {
      unlabelled.push(block);
      continue;
    }

    let target = byKey.get(parsed.key);

    if (!target && !parsed.subPart) {
      // Student wrote just the number; accept it when that number is unambiguous.
      const candidates = byNumber.get(parsed.number) ?? [];
      if (candidates.length === 1) target = candidates[0];
    }

    if (!target) {
      strayLabelled.push(block);
      continue;
    }

    const list = matched.get(target.id) ?? [];
    list.push(block.id);
    matched.set(target.id, list);
  }

  return { matched, unlabelled, strayLabelled };
}

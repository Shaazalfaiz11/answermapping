/** Shared domain types for the extraction -> mapping -> grading pipeline. */

/** A rendered page of an uploaded document, held in browser memory only. */
export interface PageImage {
  index: number;
  /** PNG data URL of the rendered page. */
  dataUrl: string;
  width: number;
  height: number;
}

/** A horizontal band of ink detected geometrically on an answer-sheet page. */
export interface LineBand {
  /** 1-based index within the page, in reading order (top to bottom). */
  index: number;
  /** Normalised 0..1 coordinates relative to the page image. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface AnswerPage extends PageImage {
  bands: LineBand[];
  /** Page image with band numbers drawn into the left margin, sent to the vision model. */
  annotatedDataUrl: string;
}

/** One question extracted from the question paper. Sub-parts are separate entries. */
export interface Question {
  /** Stable id, e.g. "11a" or "3". */
  id: string;
  /** Printed main number, e.g. "11". */
  number: string;
  /** Printed sub-part label without punctuation, e.g. "a". Empty when there is none. */
  subPart: string;
  /** Label as printed, e.g. "11 (a)". */
  label: string;
  text: string;
  /** Maximum marks, when the paper states them. */
  marks: number | null;
  /** Index into the question-paper page list. */
  pageIndex: number;
  /** Printed order, 0-based. Drives display order regardless of extraction order. */
  order: number;
}

/** A contiguous run of handwriting on one answer-sheet page. */
export interface AnswerBlock {
  id: string;
  pageIndex: number;
  /** Band index where the block starts (1-based, inclusive). */
  startLine: number;
  /** Band index where the block ends (1-based, inclusive). */
  endLine: number;
  /** Question label the student wrote above the block, if any. */
  writtenLabel: string | null;
  /** Transcribed answer text. */
  text: string;
  /** True when the block is mostly a drawing/diagram rather than prose. */
  isDiagram: boolean;
  /** Model confidence in the transcription, 0..1. */
  confidence: number;
}

/** A highlight rectangle on one page, normalised 0..1. */
export interface Region {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MatchMethod = "label" | "content" | "sequence" | "none";

/** The result of mapping answer blocks onto a question. */
export interface QuestionMapping {
  questionId: string;
  blockIds: string[];
  regions: Region[];
  answerText: string;
  answered: boolean;
  method: MatchMethod;
  /** 0..1 confidence in the mapping itself (not the transcription). */
  confidence: number;
  /** Short human-readable justification, shown to the teacher on low confidence. */
  note?: string;
}

export type Verdict = "correct" | "partial" | "incorrect" | "unanswered";

export interface Grade {
  questionId: string;
  score: number;
  maxScore: number;
  verdict: Verdict;
  feedback: string;
}

/** An answer block that could not be attached to any question. */
export interface OrphanAnswer {
  blockId: string;
  pageIndex: number;
  regions: Region[];
  text: string;
  writtenLabel: string | null;
  reason: string;
}

export interface GradingSummary {
  totalScore: number;
  totalMax: number;
  answeredCount: number;
  unansweredCount: number;
  orphanCount: number;
  overallFeedback: string;
  strengths: string[];
  improvements: string[];
}

/** Everything the review screen renders. */
export interface AnalysisResult {
  questions: Question[];
  blocks: AnswerBlock[];
  mappings: QuestionMapping[];
  grades: Grade[];
  orphans: OrphanAnswer[];
  summary: GradingSummary;
}

export type StageId =
  | "render"
  | "questions"
  | "segment"
  | "answers"
  | "mapping"
  | "grading";

export interface StageState {
  id: StageId;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
  /** 0..1 within this stage. */
  progress: number;
}

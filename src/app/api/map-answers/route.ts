import { NextResponse } from "next/server";
import { TEXT_MODEL, completeJson } from "@/lib/groq";
import { MAPPING_SYSTEM } from "@/lib/prompts";
import { matchByLabel, similarity } from "@/lib/mapping";
import type { AnswerBlock, MatchMethod, Question } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RequestBody {
  questions: Question[];
  blocks: AnswerBlock[];
}

interface RawMatch {
  blockId?: string;
  questionId?: string;
  confidence?: number;
  reason?: string;
}

export interface MappingResponse {
  /** questionId -> the blocks that answer it. */
  assignments: Array<{
    questionId: string;
    blockIds: string[];
    method: MatchMethod;
    confidence: number;
    note?: string;
  }>;
  /** Blocks that answer no question on the paper. */
  orphans: Array<{ blockId: string; reason: string }>;
}

/** Trim a block for the text-only model; full transcripts blow the token budget. */
function briefBlock(b: AnswerBlock) {
  return {
    blockId: b.id,
    page: b.pageIndex + 1,
    writtenLabel: b.writtenLabel,
    text: b.text.slice(0, 600),
    isDiagram: b.isDiagram,
  };
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const questions = body.questions ?? [];
  const blocks = body.blocks ?? [];

  if (questions.length === 0) {
    return NextResponse.json({ error: "No questions supplied" }, { status: 400 });
  }

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const { matched, unlabelled, strayLabelled } = matchByLabel(questions, blocks);

  const assignments: MappingResponse["assignments"] = [];
  for (const [questionId, blockIds] of matched) {
    assignments.push({
      questionId,
      blockIds,
      method: "label",
      confidence: 0.98,
      note: "Matched on the question number written by the student",
    });
  }

  // Anything without a resolvable label goes to the model, which matches on content.
  const needsContentMatch = [...unlabelled, ...strayLabelled];
  const orphans: MappingResponse["orphans"] = [];

  if (needsContentMatch.length > 0) {
    const alreadyAnswered = new Set(assignments.map((a) => a.questionId));

    try {
      const result = await completeJson<{
        matches?: RawMatch[];
        unmatched?: Array<{ blockId?: string; reason?: string }>;
      }>({
        model: TEXT_MODEL,
        signal: req.signal,
        system: MAPPING_SYSTEM,
        maxTokens: 800,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              questions: questions.map((q) => ({
                questionId: q.id,
                label: q.label,
                text: q.text.slice(0, 400),
                alreadyAnswered: alreadyAnswered.has(q.id),
              })),
              blocks: needsContentMatch.map(briefBlock),
            }),
          },
        ],
      });

      const validQuestionIds = new Set(questions.map((q) => q.id));
      const claimed = new Set<string>();

      for (const m of result.matches ?? []) {
        const blockId = m.blockId ?? "";
        const questionId = m.questionId ?? "";
        // Ignore hallucinated ids rather than trusting them into the UI.
        if (!byId.has(blockId) || !validQuestionIds.has(questionId)) continue;
        if (claimed.has(blockId)) continue;
        claimed.add(blockId);

        const confidence = typeof m.confidence === "number" ? m.confidence : 0.6;
        const existing = assignments.find((a) => a.questionId === questionId);
        if (existing) {
          existing.blockIds.push(blockId);
          if (existing.method !== "label") {
            existing.confidence = Math.min(existing.confidence, confidence);
          }
        } else {
          assignments.push({
            questionId,
            blockIds: [blockId],
            method: "content",
            confidence: Math.max(0, Math.min(1, confidence)),
            note: m.reason?.trim() || "Matched on answer content",
          });
        }
      }

      for (const u of result.unmatched ?? []) {
        const blockId = u.blockId ?? "";
        if (!byId.has(blockId) || claimed.has(blockId)) continue;
        claimed.add(blockId);
        orphans.push({
          blockId,
          reason: u.reason?.trim() || "Does not correspond to any question on the paper",
        });
      }

      // Anything the model simply did not mention is still unaccounted for.
      for (const block of needsContentMatch) {
        if (claimed.has(block.id)) continue;
        orphans.push({
          blockId: block.id,
          reason: "Could not be matched to any question",
        });
      }
    } catch {
      // If the content pass fails, fall back to a keyword score so the teacher
      // still gets a usable - if weaker - mapping instead of an error screen.
      for (const block of needsContentMatch) {
        let best: { q: Question; score: number } | null = null;
        for (const q of questions) {
          const score = similarity(q.text, block.text);
          if (!best || score > best.score) best = { q, score };
        }

        if (best && best.score >= 0.25) {
          const existing = assignments.find((a) => a.questionId === best!.q.id);
          if (existing) existing.blockIds.push(block.id);
          else
            assignments.push({
              questionId: best.q.id,
              blockIds: [block.id],
              method: "content",
              confidence: Math.min(0.5, best.score),
              note: "Keyword match (AI matching unavailable)",
            });
        } else {
          orphans.push({
            blockId: block.id,
            reason: "Could not be matched to any question",
          });
        }
      }
    }
  }

  // Keep each question's blocks in reading order so multi-page answers read correctly.
  for (const a of assignments) {
    a.blockIds.sort((x, y) => {
      const bx = byId.get(x)!;
      const by = byId.get(y)!;
      return bx.pageIndex - by.pageIndex || bx.startLine - by.startLine;
    });
  }

  const response: MappingResponse = { assignments, orphans };
  return NextResponse.json(response);
}

import { NextResponse } from "next/server";
import { TEXT_MODEL, completeJson, mapLimited } from "@/lib/groq";
import { GRADING_SYSTEM, SUMMARY_SYSTEM } from "@/lib/prompts";
import type { Grade, GradingSummary, Verdict } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface GradeItem {
  questionId: string;
  label: string;
  questionText: string;
  marks: number | null;
  answerText: string;
  answered: boolean;
}

interface RequestBody {
  items: GradeItem[];
  orphanCount: number;
}

interface RawGrade {
  questionId?: string;
  score?: number | string;
  maxScore?: number | string;
  verdict?: string;
  feedback?: string;
}

/** Grade in batches so one long paper does not exceed the per-request budget. */
const BATCH_SIZE = 4;

const VERDICTS: Verdict[] = ["correct", "partial", "incorrect", "unanswered"];

const toNumber = (v: number | string | undefined, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : fallback;
};

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const items = body.items ?? [];
  if (items.length === 0) {
    return NextResponse.json({ error: "Nothing to grade" }, { status: 400 });
  }

  const answered = items.filter((i) => i.answered && i.answerText.trim());
  const unanswered = items.filter((i) => !i.answered || !i.answerText.trim());

  // Unanswered questions are a certainty, not a judgement call: score them in code.
  const grades: Grade[] = unanswered.map((i) => ({
    questionId: i.questionId,
    score: 0,
    maxScore: i.marks ?? 1,
    verdict: "unanswered" as const,
    feedback: "No answer was found for this question on the answer sheet.",
  }));

  const batches: GradeItem[][] = [];
  for (let i = 0; i < answered.length; i += BATCH_SIZE) {
    batches.push(answered.slice(i, i + BATCH_SIZE));
  }

  try {
    const results = await mapLimited(batches, 1, async (batch) =>
      completeJson<{ grades?: RawGrade[] }>({
        model: TEXT_MODEL,
        system: GRADING_SYSTEM,
        maxTokens: 1500,
        temperature: 0.2,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              batch.map((i) => ({
                questionId: i.questionId,
                question: i.questionText,
                maxScore: i.marks ?? 1,
                studentAnswer: i.answerText.slice(0, 2000),
              })),
            ),
          },
        ],
      }),
    );

    const byId = new Map(answered.map((i) => [i.questionId, i]));

    for (const raw of results.flatMap((r) => r.grades ?? [])) {
      const item = byId.get(String(raw.questionId ?? ""));
      if (!item) continue;

      const maxScore = item.marks ?? toNumber(raw.maxScore, 1);
      const score = Math.max(0, Math.min(maxScore, toNumber(raw.score, 0)));
      const verdictRaw = String(raw.verdict ?? "").toLowerCase() as Verdict;
      const verdict: Verdict = VERDICTS.includes(verdictRaw)
        ? verdictRaw
        : score >= maxScore
          ? "correct"
          : score > 0
            ? "partial"
            : "incorrect";

      grades.push({
        questionId: item.questionId,
        score,
        maxScore,
        verdict: verdict === "unanswered" ? "incorrect" : verdict,
        feedback: String(raw.feedback ?? "").trim() || "No feedback generated.",
      });
      byId.delete(item.questionId);
    }

    // Any answered question the model skipped still needs a row.
    for (const item of byId.values()) {
      grades.push({
        questionId: item.questionId,
        score: 0,
        maxScore: item.marks ?? 1,
        verdict: "partial",
        feedback: "An answer was found but could not be graded automatically. Please review.",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Grading failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const order = new Map(items.map((i, idx) => [i.questionId, idx]));
  grades.sort((a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0));

  const totalScore = grades.reduce((sum, g) => sum + g.score, 0);
  const totalMax = grades.reduce((sum, g) => sum + g.maxScore, 0);

  let overallFeedback = "";
  let strengths: string[] = [];
  let improvements: string[] = [];

  try {
    const summary = await completeJson<{
      overallFeedback?: string;
      strengths?: string[];
      improvements?: string[];
    }>({
      model: TEXT_MODEL,
      system: SUMMARY_SYSTEM,
      maxTokens: 700,
      temperature: 0.3,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            totalScore,
            totalMax,
            unansweredCount: unanswered.length,
            unmatchedAnswerCount: body.orphanCount ?? 0,
            perQuestion: grades.map((g) => {
              const item = items.find((i) => i.questionId === g.questionId);
              return {
                label: item?.label ?? g.questionId,
                question: item?.questionText.slice(0, 200) ?? "",
                score: g.score,
                maxScore: g.maxScore,
                verdict: g.verdict,
              };
            }),
          }),
        },
      ],
    });

    overallFeedback = String(summary.overallFeedback ?? "").trim();
    strengths = (summary.strengths ?? []).map(String).filter(Boolean).slice(0, 4);
    improvements = (summary.improvements ?? []).map(String).filter(Boolean).slice(0, 4);
  } catch {
    // The summary is a nice-to-have; a per-question grade set is still useful.
    const pct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    overallFeedback = `Scored ${totalScore} out of ${totalMax} (${pct}%), with ${unanswered.length} question(s) left unanswered.`;
  }

  const summary: GradingSummary = {
    totalScore,
    totalMax,
    answeredCount: answered.length,
    unansweredCount: unanswered.length,
    orphanCount: body.orphanCount ?? 0,
    overallFeedback,
    strengths,
    improvements,
  };

  return NextResponse.json({ grades, summary });
}

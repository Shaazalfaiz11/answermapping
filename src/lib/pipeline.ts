"use client";

import { annotateBands, bandsToRegion, detectBands } from "./lineDetect";
import { renderToPages, toModelImage } from "./pdf";
import type {
  AnalysisResult,
  AnswerBlock,
  AnswerPage,
  Grade,
  OrphanAnswer,
  PageImage,
  Question,
  QuestionMapping,
  Region,
  StageId,
} from "./types";

/**
 * Drives the whole run from the browser: render -> extract questions ->
 * segment lines -> extract answers -> map -> grade.
 *
 * The client orchestrates rather than one long server call, because each stage
 * is a separate short request. That keeps every call well inside serverless
 * time limits and gives the progress UI something real to report.
 */

export interface PipelineOutput extends AnalysisResult {
  questionPages: PageImage[];
  answerPages: AnswerPage[];
}

type Reporter = (stage: StageId, progress: number, detail?: string) => void;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** Run tasks with a small concurrency cap to respect free-tier rate limits. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Merge a block's line range into page-anchored highlight rectangles. */
function regionsFor(blocks: AnswerBlock[], pages: AnswerPage[]): Region[] {
  const regions: Region[] = [];

  for (const block of blocks) {
    const page = pages[block.pageIndex];
    if (!page) continue;
    const rect = bandsToRegion(page.bands, block.startLine, block.endLine);
    if (rect) regions.push({ pageIndex: block.pageIndex, ...rect });
  }
  return regions;
}

export async function runPipeline(
  questionFiles: File[],
  answerFiles: File[],
  report: Reporter,
): Promise<PipelineOutput> {
  // 1. Rasterise both documents in the browser.
  report("render", 0, "Rendering pages");
  const questionPages = await renderToPages(questionFiles, (f) =>
    report("render", f * 0.4, "Rendering question paper"),
  );
  const rawAnswerPages = await renderToPages(answerFiles, (f) =>
    report("render", 0.4 + f * 0.6, "Rendering answer sheet"),
  );
  report("render", 1, `${questionPages.length + rawAnswerPages.length} pages ready`);

  /*
   * 2-4. Questions and answers are independent inputs, and they run on
   * different model buckets, so reading the paper does not have to finish
   * before the answer sheet starts. The question call goes out first and stays
   * in flight while the CPU-only line segmentation runs, which would otherwise
   * be dead time with no request outstanding.
   */
  report("questions", 0.1, "Reading the question paper");

  const modelQuestionImages = await Promise.all(
    questionPages.map(async (p) => ({
      index: p.index,
      dataUrl: await toModelImage(p.dataUrl),
    })),
  );

  const questionsPromise = postJson<{ questions: Question[] }>(
    "/api/extract-questions",
    { pages: modelQuestionImages },
  ).then(({ questions }) => {
    if (questions.length === 0) {
      throw new Error(
        "No questions could be read from the question paper. Try a clearer scan.",
      );
    }
    report("questions", 1, `${questions.length} questions found`);
    return questions;
  });
  // Nothing awaits this until the join below; without a handler a failure here
  // would surface as an unhandled rejection before it can be reported properly.
  questionsPromise.catch(() => undefined);

  // 3. Find the ink lines on each answer page and number them for the model.
  report("segment", 0, "Locating handwriting");
  const answerPages: AnswerPage[] = [];
  for (const page of rawAnswerPages) {
    const bands = await detectBands(page.dataUrl);
    const annotatedDataUrl = await annotateBands(page, bands);
    answerPages.push({ ...page, bands, annotatedDataUrl });
    report(
      "segment",
      answerPages.length / rawAnswerPages.length,
      `Page ${answerPages.length} of ${rawAnswerPages.length}`,
    );
  }

  // 4. Transcribe each answer page, one request per page. Concurrency matches
  //    the number of vision buckets: more would only queue on a token budget.
  report("answers", 0, "Reading the answer sheet");
  let pagesDone = 0;
  const blocksPromise = pooled(answerPages, 2, async (page) => {
    const { blocks } = await postJson<{ blocks: AnswerBlock[] }>("/api/extract-answers", {
      pageIndex: page.index,
      dataUrl: page.annotatedDataUrl,
      bandCount: page.bands.length,
    });
    pagesDone++;
    report(
      "answers",
      pagesDone / answerPages.length,
      `Page ${pagesDone} of ${answerPages.length}`,
    );
    return blocks;
  });

  const [questions, perPage] = await Promise.all([questionsPromise, blocksPromise]);
  const blocks = perPage.flat();

  // 5. Map answer blocks onto questions.
  report("mapping", 0.2, "Matching answers to questions");
  const { assignments, orphans: rawOrphans } = await postJson<{
    assignments: Array<{
      questionId: string;
      blockIds: string[];
      method: QuestionMapping["method"];
      confidence: number;
      note?: string;
    }>;
    orphans: Array<{ blockId: string; reason: string }>;
  }>("/api/map-answers", { questions, blocks });

  const blockById = new Map(blocks.map((b) => [b.id, b]));

  const mappings: QuestionMapping[] = questions.map((q) => {
    const assignment = assignments.find((a) => a.questionId === q.id);
    const matched = (assignment?.blockIds ?? [])
      .map((id) => blockById.get(id))
      .filter((b): b is AnswerBlock => Boolean(b));

    return {
      questionId: q.id,
      blockIds: matched.map((b) => b.id),
      regions: regionsFor(matched, answerPages),
      answerText: matched.map((b) => b.text).join("\n\n").trim(),
      answered: matched.length > 0,
      method: assignment?.method ?? "none",
      confidence: assignment?.confidence ?? 0,
      note: assignment?.note,
    };
  });

  const orphans: OrphanAnswer[] = rawOrphans
    .map((o) => {
      const block = blockById.get(o.blockId);
      if (!block) return null;
      return {
        blockId: block.id,
        pageIndex: block.pageIndex,
        regions: regionsFor([block], answerPages),
        text: block.text,
        writtenLabel: block.writtenLabel,
        reason: o.reason,
      };
    })
    .filter((o): o is OrphanAnswer => o !== null);

  report("mapping", 1, `${mappings.filter((m) => m.answered).length} answers matched`);

  // 6. Grade and summarise.
  report("grading", 0.2, "Grading answers");
  const { grades, summary } = await postJson<{
    grades: Grade[];
    summary: AnalysisResult["summary"];
  }>("/api/grade", {
    items: questions.map((q) => {
      const mapping = mappings.find((m) => m.questionId === q.id)!;
      return {
        questionId: q.id,
        label: q.label,
        questionText: q.text,
        marks: q.marks,
        answerText: mapping.answerText,
        answered: mapping.answered,
      };
    }),
    orphanCount: orphans.length,
  });
  report("grading", 1, "Done");

  return {
    questions,
    blocks,
    mappings,
    grades,
    orphans,
    summary,
    questionPages,
    answerPages,
  };
}

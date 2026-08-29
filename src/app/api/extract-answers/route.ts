import { NextResponse } from "next/server";
import { completeJson, visionModelFor } from "@/lib/groq";
import { ANSWER_EXTRACTION_SYSTEM } from "@/lib/prompts";
import type { AnswerBlock } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RequestBody {
  pageIndex: number;
  /** Page image with the numbered gutter drawn on. */
  dataUrl: string;
  /** Number of bands detected on this page; line numbers must fall inside it. */
  bandCount: number;
}

interface RawBlock {
  questionLabel?: string | null;
  startLine?: number | string;
  endLine?: number | string;
  text?: string;
  isDiagram?: boolean;
  confidence?: number;
}

const toInt = (v: number | string | undefined): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
};

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { pageIndex, dataUrl, bandCount } = body;
  if (!dataUrl) {
    return NextResponse.json({ error: "No page image supplied" }, { status: 400 });
  }

  // A page with no detected ink has nothing to transcribe.
  if (!bandCount || bandCount < 1) {
    return NextResponse.json({ blocks: [] });
  }

  try {
    const result = await completeJson<{ blocks?: RawBlock[] }>({
      // Alternate buckets by page so consecutive pages do not queue behind
      // each other on one model's token budget.
      model: visionModelFor(pageIndex),
      signal: req.signal,
      system: ANSWER_EXTRACTION_SYSTEM,
      maxTokens: 1000,
      content: [
        {
          type: "text",
          text:
            `Answer sheet page ${pageIndex + 1}. The gutter is numbered L1 to L${bandCount}. ` +
            `Every startLine and endLine you return must be between 1 and ${bandCount}.`,
        },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    });

    const blocks: AnswerBlock[] = [];

    (result.blocks ?? []).forEach((raw, i) => {
      const text = String(raw.text ?? "").trim();
      let start = toInt(raw.startLine);
      let end = toInt(raw.endLine);

      // Clamp into the range we actually measured; a hallucinated line number
      // would otherwise produce a highlight over empty paper.
      if (start === null && end === null) return;
      start = Math.min(Math.max(start ?? end ?? 1, 1), bandCount);
      end = Math.min(Math.max(end ?? start, 1), bandCount);
      if (end < start) [start, end] = [end, start];

      const label = raw.questionLabel;
      const writtenLabel =
        typeof label === "string" && label.trim() && label.trim().toLowerCase() !== "null"
          ? label.trim()
          : null;

      if (!text && !raw.isDiagram) return;

      blocks.push({
        id: `p${pageIndex}b${i}`,
        pageIndex,
        startLine: start,
        endLine: end,
        writtenLabel,
        text,
        isDiagram: Boolean(raw.isDiagram),
        confidence:
          typeof raw.confidence === "number"
            ? Math.max(0, Math.min(1, raw.confidence))
            : 0.7,
      });
    });

    blocks.sort((a, b) => a.startLine - b.startLine);
    return NextResponse.json({ blocks });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Answer extraction failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

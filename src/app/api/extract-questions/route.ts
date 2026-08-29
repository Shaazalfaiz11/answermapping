import { NextResponse } from "next/server";
import {
  MAX_IMAGES_PER_REQUEST,
  VISION_MODEL,
  completeJson,
  mapLimited,
} from "@/lib/groq";
import { QUESTION_EXTRACTION_SYSTEM } from "@/lib/prompts";
import { questionKey } from "@/lib/mapping";
import type { Question } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RequestBody {
  pages: Array<{ index: number; dataUrl: string }>;
}

interface RawQuestion {
  number?: string | number;
  subPart?: string;
  text?: string;
  marks?: number | string | null;
  pageIndex?: number;
}

function cleanNumber(value: string | number | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/^(?:q(?:uestion)?)[\s.)-]*/i, "")
    .replace(/[.)\]]+$/, "")
    .trim();
}

function cleanSubPart(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/[()[\].]/g, "")
    .toLowerCase();
}

function cleanMarks(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pages = body.pages ?? [];
  if (pages.length === 0) {
    return NextResponse.json({ error: "No pages supplied" }, { status: 400 });
  }

  // The vision model caps images per request, so send the paper in small batches.
  const batches: RequestBody["pages"][] = [];
  for (let i = 0; i < pages.length; i += MAX_IMAGES_PER_REQUEST) {
    batches.push(pages.slice(i, i + MAX_IMAGES_PER_REQUEST));
  }

  try {
    const perBatch = await mapLimited(batches, 1, async (batch) => {
      const indexList = batch.map((p) => p.index).join(", ");
      const result = await completeJson<{ questions?: RawQuestion[] }>({
        model: VISION_MODEL,
        system: QUESTION_EXTRACTION_SYSTEM,
        maxTokens: 3000,
        content: [
          {
            type: "text",
            text:
              `These are pages of one question paper. The images are, in order, ` +
              `pageIndex ${indexList}. Use those exact values for pageIndex. ` +
              `Extract every question in printed order.`,
          },
          ...batch.map((p) => ({
            type: "image_url" as const,
            image_url: { url: p.dataUrl },
          })),
        ],
      });

      return (result.questions ?? []).map((q) => ({
        raw: q,
        fallbackPage: batch[0].index,
        validPages: batch.map((p) => p.index),
      }));
    });

    const seen = new Set<string>();
    const questions: Question[] = [];

    for (const item of perBatch.flat()) {
      const number = cleanNumber(item.raw.number);
      if (!number) continue;

      const subPart = cleanSubPart(item.raw.subPart);
      const key = questionKey(number, subPart);
      // A question spanning a batch boundary can be reported twice; keep the first.
      if (seen.has(key)) continue;
      seen.add(key);

      const reportedPage = Number(item.raw.pageIndex);
      const pageIndex = item.validPages.includes(reportedPage)
        ? reportedPage
        : item.fallbackPage;

      questions.push({
        id: key,
        number,
        subPart,
        label: subPart ? `${number} (${subPart})` : number,
        text: String(item.raw.text ?? "").trim(),
        marks: cleanMarks(item.raw.marks),
        pageIndex,
        order: 0,
      });
    }

    // Preserve printed order: page first, then numeric value, then sub-part.
    questions.sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      const na = Number(a.number);
      const nb = Number(b.number);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      if (a.number !== b.number) return a.number.localeCompare(b.number);
      return a.subPart.localeCompare(b.subPart);
    });
    questions.forEach((q, i) => (q.order = i));

    return NextResponse.json({ questions });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Question extraction failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

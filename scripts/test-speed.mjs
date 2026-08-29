import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";

const BASE = "http://localhost:3005";
const dispatcher = new Agent({
  headersTimeout: 120_000,
  bodyTimeout: 120_000,
});

const dataUrl = (path, mime) =>
  `data:${mime};base64,${readFileSync(path).toString("base64")}`;

async function post(route, body) {
  const t0 = performance.now();
  const res = await undiciFetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    dispatcher,
  });
  const elapsed = performance.now() - t0;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} -> ${res.status}: ${json.error ?? "?"}`);
  return { data: json, elapsed };
}

console.log("=== Pipeline Speed Test ===");
const overallT0 = performance.now();

// 1. Questions
console.log("1. Extracting questions...");
const qRes = await post("/api/extract-questions", {
  pages: [{ index: 0, dataUrl: dataUrl("fixtures/question_paper_p1.png", "image/png") }],
});
console.log(`   ✓ Questions done in ${(qRes.elapsed / 1000).toFixed(2)}s (${qRes.data.questions.length} questions)`);

// 2. Answers (3 pages)
console.log("2. Extracting answers (3 pages)...");
const pages = [
  { index: 0, file: "fixtures/answer_sheet_p1.annotated.jpg", bands: 20 },
  { index: 1, file: "fixtures/answer_sheet_p2.annotated.jpg", bands: 10 },
  { index: 2, file: "fixtures/answer_sheet_p3.annotated.jpg", bands: 1 },
];

const tA = performance.now();
const blocks = [];
for (const page of pages) {
  const pT0 = performance.now();
  const res = await post("/api/extract-answers", {
    pageIndex: page.index,
    dataUrl: dataUrl(page.file, "image/jpeg"),
    bandCount: page.bands,
  });
  blocks.push(...res.data.blocks);
  console.log(`   ✓ Page ${page.index + 1} done in ${((performance.now() - pT0) / 1000).toFixed(2)}s (${res.data.blocks.length} blocks)`);
}
console.log(`   ✓ All answers done in ${((performance.now() - tA) / 1000).toFixed(2)}s`);

// 3. Mapping
console.log("3. Mapping answers...");
const mapRes = await post("/api/map-answers", { questions: qRes.data.questions, blocks });
console.log(`   ✓ Mapping done in ${(mapRes.elapsed / 1000).toFixed(2)}s (${mapRes.data.assignments.length} mapped)`);

// 4. Grading
console.log("4. Grading...");
const byQuestion = new Map(mapRes.data.assignments.map((a) => [a.questionId, a]));
const answerTextOf = (id) =>
  (byQuestion.get(id)?.blockIds ?? [])
    .map((b) => blocks.find((x) => x.id === b)?.text ?? "")
    .join("\n\n");

const gradeRes = await post("/api/grade", {
  items: qRes.data.questions.map((q) => ({
    questionId: q.id,
    label: q.label,
    questionText: q.text,
    marks: q.marks,
    answerText: answerTextOf(q.id),
    answered: byQuestion.has(q.id),
  })),
  orphanCount: mapRes.data.orphans.length,
});
console.log(`   ✓ Grading done in ${(gradeRes.elapsed / 1000).toFixed(2)}s (Score: ${gradeRes.data.summary.totalScore}/${gradeRes.data.summary.totalMax})`);

const totalSec = ((performance.now() - overallT0) / 1000).toFixed(2);
console.log(`\n========================================`);
console.log(`TOTAL PIPELINE TIME: ${totalSec}s`);
console.log(`========================================`);

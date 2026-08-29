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

console.log("Starting timing test...");

// 1. Questions
const tQ = performance.now();
const qRes = await post("/api/extract-questions", {
  pages: [{ index: 0, dataUrl: dataUrl("fixtures/question_paper_p1.png", "image/png") }],
});
console.log(`Extract Questions: ${(performance.now() - tQ).toFixed(0)}ms (${qRes.data.questions.length} questions)`);

// 2. Answers (3 pages)
const pages = [
  { index: 0, file: "fixtures/answer_sheet_p1.annotated.jpg", bands: 20 },
  { index: 1, file: "fixtures/answer_sheet_p2.annotated.jpg", bands: 10 },
  { index: 2, file: "fixtures/answer_sheet_p3.annotated.jpg", bands: 1 },
];

const tA = performance.now();
const blocks = [];
const answerProms = pages.map((page) =>
  post("/api/extract-answers", {
    pageIndex: page.index,
    dataUrl: dataUrl(page.file, "image/jpeg"),
    bandCount: page.bands,
  })
);
const answerResults = await Promise.all(answerProms);
for (const r of answerResults) blocks.push(...r.data.blocks);
console.log(`Extract Answers (3 pages in parallel): ${(performance.now() - tA).toFixed(0)}ms (${blocks.length} blocks)`);

// 3. Mapping
const tM = performance.now();
const mapRes = await post("/api/map-answers", { questions: qRes.data.questions, blocks });
console.log(`Map Answers: ${(performance.now() - tM).toFixed(0)}ms (${mapRes.data.assignments.length} mapped, ${mapRes.data.orphans.length} orphans)`);

// 4. Grading
const byQuestion = new Map(mapRes.data.assignments.map((a) => [a.questionId, a]));
const answerTextOf = (id) =>
  (byQuestion.get(id)?.blockIds ?? [])
    .map((b) => blocks.find((x) => x.id === b)?.text ?? "")
    .join("\n\n");

const tG = performance.now();
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
console.log(`Grading: ${(performance.now() - tG).toFixed(0)}ms`);

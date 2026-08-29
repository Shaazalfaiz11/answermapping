/**
 * End-to-end check against the running dev server and the real Groq API.
 *
 * Feeds the fixture question paper and the annotated answer pages through every
 * route, then asserts the edge cases the assignment calls out: sub-parts split,
 * printed order preserved, out-of-order answers matched, an unanswered question
 * left unanswered, an unrelated note left unmatched, and an answer that runs
 * across a page break stitched back together.
 *
 *   node scripts/e2e.mjs [baseUrl]
 */
import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";

/*
 * A route can legitimately block for minutes: the free-tier token ledger makes
 * a request wait for budget before it calls Groq at all. Node's global fetch
 * gives up after 300s, failing the test for a reason unrelated to the code
 * under test - browsers have no such limit.
 *
 * The dispatcher is passed per request rather than via setGlobalDispatcher,
 * which does not reliably reach Node's built-in fetch (that uses its own
 * bundled copy of undici, not this one).
 */
const dispatcher = new Agent({
  headersTimeout: 20 * 60_000,
  bodyTimeout: 20 * 60_000,
});

const BASE = process.argv[2] ?? "http://localhost:3005";

const dataUrl = (path, mime) =>
  `data:${mime};base64,${readFileSync(path).toString("base64")}`;

async function post(route, body) {
  const res = await undiciFetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    dispatcher,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} -> ${res.status}: ${json.error ?? "?"}`);
  return json;
}

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
};

console.log("1. Extracting questions from the question paper...");
const { questions } = await post("/api/extract-questions", {
  pages: [{ index: 0, dataUrl: dataUrl("fixtures/question_paper_p1.png", "image/png") }],
});

for (const q of questions) {
  console.log(
    `   ${q.label.padEnd(8)} marks=${String(q.marks).padEnd(4)} ${q.text.slice(0, 66)}`,
  );
}

console.log("\n   Checks:");
check("9 questions extracted", questions.length === 9, `got ${questions.length}`);
check(
  "sub-parts are separate entries",
  questions.filter((q) => q.number === "7").length === 2,
  questions
    .filter((q) => q.number === "7")
    .map((q) => q.label)
    .join(", "),
);
check(
  "printed order preserved",
  questions.map((q) => q.label.replace(/\s/g, "")).join(",") ===
    "1,2,3,4,5,6,7(a),7(b),8",
  questions.map((q) => q.label.replace(/\s/g, "")).join(","),
);
check(
  "marks captured",
  questions.every((q) => q.marks !== null),
  questions.map((q) => q.marks).join(","),
);
check(
  "instructions not treated as questions",
  !questions.some((q) => /time:|answer all questions/i.test(q.text)),
);

console.log("\n2. Extracting answers from 3 answer pages...");
const pages = [
  { index: 0, file: "fixtures/answer_sheet_p1.annotated.jpg", bands: 20 },
  { index: 1, file: "fixtures/answer_sheet_p2.annotated.jpg", bands: 10 },
  { index: 2, file: "fixtures/answer_sheet_p3.annotated.jpg", bands: 1 },
];

const blocks = [];
for (const page of pages) {
  const res = await post("/api/extract-answers", {
    pageIndex: page.index,
    dataUrl: dataUrl(page.file, "image/jpeg"),
    bandCount: page.bands,
  });
  for (const b of res.blocks) {
    console.log(
      `   p${b.pageIndex + 1} L${b.startLine}-${b.endLine} label=${String(b.writtenLabel).padEnd(6)} ${b.text.slice(0, 58)}`,
    );
    blocks.push(b);
  }
}

console.log("\n   Checks:");
check("answer blocks found", blocks.length >= 8, `got ${blocks.length}`);
check(
  "line numbers within detected bands",
  blocks.every((b) => {
    const page = pages.find((p) => p.index === b.pageIndex);
    return b.startLine >= 1 && b.endLine <= page.bands && b.startLine <= b.endLine;
  }),
);
check(
  "student labels read",
  blocks.filter((b) => b.writtenLabel).length >= 6,
  `${blocks.filter((b) => b.writtenLabel).length} labelled`,
);

console.log("\n3. Mapping answers to questions...");
const { assignments, orphans } = await post("/api/map-answers", { questions, blocks });

const byQuestion = new Map(assignments.map((a) => [a.questionId, a]));
for (const q of questions) {
  const a = byQuestion.get(q.id);
  console.log(
    `   ${q.label.padEnd(8)} ${a ? `${a.blockIds.join("+").padEnd(12)} via ${a.method}` : "UNANSWERED"}`,
  );
}
for (const o of orphans) {
  const b = blocks.find((x) => x.id === o.blockId);
  console.log(`   orphan   ${o.blockId} "${b?.text.slice(0, 40)}" - ${o.reason}`);
}

console.log("\n   Checks:");
check(
  "out-of-order answer mapped (Q5 written before Q3)",
  byQuestion.has("5") && byQuestion.has("3"),
);
check(
  "sub-parts mapped independently",
  byQuestion.has("7a") && byQuestion.has("7b"),
  `7a=${byQuestion.has("7a")} 7b=${byQuestion.has("7b")}`,
);
check("unanswered question left unanswered (Q6)", !byQuestion.has("6"));
check("unrelated note left unmatched", orphans.length >= 1, `${orphans.length} orphan(s)`);

const q8 = byQuestion.get("8");
const q8Pages = new Set(
  (q8?.blockIds ?? []).map((id) => blocks.find((b) => b.id === id)?.pageIndex),
);
check(
  "multi-page answer stitched (Q8 spans 2 pages)",
  q8Pages.size >= 2,
  `pages ${[...q8Pages].map((p) => p + 1).join(", ")}`,
);

console.log("\n4. Grading...");
const answerTextOf = (id) =>
  (byQuestion.get(id)?.blockIds ?? [])
    .map((b) => blocks.find((x) => x.id === b)?.text ?? "")
    .join("\n\n");

const { grades, summary } = await post("/api/grade", {
  items: questions.map((q) => ({
    questionId: q.id,
    label: q.label,
    questionText: q.text,
    marks: q.marks,
    answerText: answerTextOf(q.id),
    answered: byQuestion.has(q.id),
  })),
  orphanCount: orphans.length,
});

for (const g of grades) {
  const q = questions.find((x) => x.id === g.questionId);
  console.log(
    `   ${q?.label.padEnd(8)} ${String(g.score).padStart(3)}/${g.maxScore}  ${g.verdict.padEnd(11)} ${g.feedback.slice(0, 58)}`,
  );
}
console.log(`\n   Total: ${summary.totalScore}/${summary.totalMax}`);
console.log(`   ${summary.overallFeedback}`);

console.log("\n   Checks:");
check("every question graded", grades.length === questions.length, `${grades.length}`);
check(
  "unanswered scored zero",
  grades.find((g) => g.questionId === "6")?.verdict === "unanswered",
);
check(
  "scores within bounds",
  grades.every((g) => g.score >= 0 && g.score <= g.maxScore),
);
check("summary generated", Boolean(summary.overallFeedback));

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("Failed:");
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  process.exit(1);
}

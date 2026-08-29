/**
 * Drives the real app in Chromium: uploads the fixtures, waits for the run to
 * finish, and checks that the review screen renders questions and highlight
 * regions, and that selecting a question moves the highlight.
 *
 * This is the only test that covers the client half of the pipeline - pdf.js
 * rasterising, canvas line detection, and the gutter annotation.
 *
 *   node scripts/browser-test.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const usePdf = args.includes("--pdf");
// The Figma phone frames are 393px wide and drop the sidebar for a drawer.
const mobile = args.includes("--mobile");
const BASE = args.find((a) => a.startsWith("http")) ?? "http://localhost:3005";
const SHOTS = mobile
  ? "fixtures/shots-mobile"
  : usePdf
    ? "fixtures/shots-pdf"
    : "fixtures/shots";
mkdirSync(SHOTS, { recursive: true });

const questionFiles = usePdf
  ? ["fixtures/question_paper.pdf"]
  : ["fixtures/question_paper_p1.png"];
const answerFiles = usePdf
  ? ["fixtures/answer_sheet.pdf"]
  : [
      "fixtures/answer_sheet_p1.png",
      "fixtures/answer_sheet_p2.png",
      "fixtures/answer_sheet_p3.png",
    ];

console.log(`Fixtures: ${usePdf ? "PDF" : "images"} at ${mobile ? "393px (phone)" : "1440px (desktop)"}`);

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: mobile ? { width: 393, height: 853 } : { width: 1440, height: 900 },
});

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

console.log(`Opening ${BASE}`);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOTS}/1-upload-empty.png` });

console.log("Uploading fixtures...");
// A pane swaps its file input for the file card once something is chosen, so
// the indices shift as we go. Filling the second slot first leaves the
// question-paper input as the only one remaining, at index 0.
const inputs = page.locator('input[type="file"]');
await inputs.nth(1).setInputFiles(answerFiles);
await page.waitForTimeout(400);
await inputs.nth(0).setInputFiles(questionFiles);

await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/2-upload-filled.png` });

const startButton = page.getByRole("button", { name: /start mapping/i });
check("Start Mapping enabled once both files chosen", await startButton.isEnabled());
check(
  "page counts shown",
  (await page.getByText(/3 Pages/i).count()) > 0,
  await page
    .getByText(/Pages?$/i)
    .allTextContents()
    .then((t) => t.join(", ")),
);

console.log("Running the pipeline (free-tier pacing makes this slow)...");
await startButton.click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${SHOTS}/3-processing.png` });

// The whole run is rate-limited; give it room.
await page
  .getByText("Extracted Questions", { exact: false })
  .waitFor({ timeout: 15 * 60 * 1000 });

await page.waitForTimeout(2000);
await page.screenshot({ path: `${SHOTS}/4-review.png`, fullPage: false });

const questionCards = page.locator('[class*="QuestionCard_card"]');
const questionCount = await questionCards.count();
check("questions rendered", questionCount >= 8, `${questionCount} cards`);

/*
 * On the phone frames the two panes share the screen behind a Questions /
 * Answers toggle, so a check has to bring its own pane into view first. On
 * desktop both are visible and these are no-ops.
 */
const showQuestions = async () => {
  if (!mobile) return;
  await page.getByRole("button", { name: "Questions", exact: true }).first().click();
  await page.waitForTimeout(600);
};
const showAnswers = async () => {
  if (!mobile) return;
  await page.getByRole("button", { name: "Answers", exact: true }).last().click();
  await page.waitForTimeout(900);
};

await showAnswers();
if (mobile) await page.screenshot({ path: `${SHOTS}/4b-answers-pane.png` });

const pageImages = page.locator('img[alt^="Answer sheet page"]');
check("answer pages rendered", (await pageImages.count()) === 3, `${await pageImages.count()}`);

// The highlight overlay is the point of the exercise.
const regionBox = async () => {
  const region = page.locator('[class*="PageViewer_overlay"]').first();
  if ((await region.count()) === 0) return null;
  return region.boundingBox();
};

const firstBox = await regionBox();
check(
  "highlight region drawn",
  firstBox !== null,
  firstBox ? `${Math.round(firstBox.width)}x${Math.round(firstBox.height)}` : "none",
);
check(
  "highlight has sensible size",
  Boolean(firstBox && firstBox.width > 20 && firstBox.height > 5),
);

// Selecting a question focuses its region. The viewport position is
// deliberately stable - the viewer parks the selected region a third of the
// way down - so assert on the label and the page, not on coordinates.
const regionLabel = async () => {
  const focused = page.locator('[class*="PageViewer_overlayFocused"] span').first();
  return (await focused.count()) === 0 ? null : focused.textContent();
};

// Nothing is selected on arrival, which is the design's own behaviour.
check("no region focused before a question is chosen", (await regionLabel()) === null);

await showQuestions();
await questionCards.nth(0).click();
await page.waitForTimeout(1000);
await showAnswers();
const beforeLabel = await regionLabel();
check("selecting a question focuses its region", beforeLabel !== null, `${beforeLabel}`);

await showQuestions();
await questionCards.nth(3).click();
await page.waitForTimeout(1200);
await showAnswers();
await page.screenshot({ path: `${SHOTS}/5-selected.png` });

const afterLabel = await regionLabel();
check(
  "highlight follows the selected question",
  Boolean(afterLabel) && afterLabel !== beforeLabel,
  `${beforeLabel} -> ${afterLabel}`,
);
check(
  "viewer pages to where that answer is",
  (await page.getByText(/Page 2 of 3/).count()) > 0,
  "Q4 is answered on page 2",
);
check("highlight still measured", (await regionBox()) !== null);

await showQuestions();

// Expand a card to reveal the transcript and feedback.
await page.getByRole("button", { name: /expand all/i }).click();
await page.waitForTimeout(800);
check(
  "AI feedback shown when expanded",
  (await page.getByText("AI Feedback").count()) > 0,
  `${await page.getByText("AI Feedback").count()} panels`,
);
check(
  "student answer transcript shown",
  (await page.getByText("Student answer").count()) > 0,
);
await page.screenshot({ path: `${SHOTS}/6-expanded.png`, fullPage: false });

// Unanswered and unmatched handling should both be visible to the teacher.
check(
  "unanswered question flagged",
  (await page.getByText(/no answer mapped/i).count()) > 0,
);
check(
  "unmatched answer surfaced",
  (await page.getByText(/matched no question/i).count()) > 0,
);

const realErrors = consoleErrors.filter(
  (e) => !/favicon|Download the React DevTools/i.test(e),
);
check("no console errors", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));

await browser.close();

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} browser checks passed`);
console.log(`Screenshots in ${SHOTS}/`);
if (failed.length > 0) process.exit(1);

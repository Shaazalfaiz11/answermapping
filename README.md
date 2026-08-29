# AI Assessment Extraction & Answer Mapping

Upload a question paper and a student's handwritten answer sheet. The app extracts
every question in printed order, transcribes the handwritten answers, maps each
answer to the question it belongs to, highlights the exact region on the answer
sheet, and grades the script with per-question feedback.

Built with Next.js 15 + TypeScript, running on Groq's free tier.

The interface is the VedaAI Figma design, ported from the existing `Veda ai`
build: the same tokens, CSS Modules and exported assets, rewired to this
pipeline. Styling is CSS Modules against the tokens in `globals.css`, every
value of which is a Figma variable or a measured frame value.

---

## The core problem, and how this solves it

The hard requirement is *"highlight the exact region of the answer sheet."*

The obvious approach — ask a vision model for bounding boxes — does not work
reliably. Vision models are weak at emitting pixel coordinates, and a highlight
that is 15% off is worse than no highlight at all.

**So the geometry never comes from the model.** Instead:

1. **Detect the lines ourselves.** Each answer page is binarised (Otsu's method)
   and reduced to a horizontal projection profile. Runs of inked rows become
   *line bands*, merged across the gaps between ascenders and descenders, with
   printed rules and margin lines detected and excluded. This is deterministic,
   and unlike OCR it works on handwriting because it never tries to read
   anything — it only finds where ink sits.

2. **Number the bands into the image.** The page is redrawn with a grey gutter
   down the left edge, each band labelled `L1`, `L2`, `L3`… The model literally
   sees the numbers.

3. **Ask the model for line ranges, not coordinates.** It answers
   *"Q3 runs from L13 to L15"* — something language models are genuinely good at.

4. **Compute the rectangle from our own measurements.** The highlight is the
   union of bands L13–L15, in normalised 0–1 coordinates, so the overlay stays
   pixel-accurate at any zoom or container width.

Each half of the system does what it is actually good at: deterministic image
processing finds *where*, the model reads *what*.

### Mapping

Label matching happens in code first, because a label a student wrote is exact
evidence and beats anything a model infers. `parseLabel()` normalises the forms
students actually write — `Q3`, `3.`, `Ans 11(a)`, `11 a)`, `5(ii)`, `Answer to 7`
— and matches them against the extracted questions, including the common case of
writing `11` when only one sub-part exists.

Only the leftovers — unlabelled blocks, or labels matching no question — go to
the model for content-based matching. Its answer is validated against the real
id sets before it reaches the UI, so a hallucinated id is dropped rather than
displayed. If that call fails entirely, a dependency-free keyword-overlap score
takes over so the teacher still gets a usable mapping instead of an error screen.

---

## Pipeline

```
render (browser) → questions → segment (browser) → answers → mapping → grading
```

| Stage | Where | Model | What it does |
|---|---|---|---|
| Render | Browser | — | pdf.js / canvas rasterises pages. Files never leave the browser. |
| Questions | `/api/extract-questions` | `qwen/qwen3.6-27b` | Every question in printed order, sub-parts split out |
| Segment | Browser | — | Projection-profile line bands + numbered gutter |
| Answers | `/api/extract-answers` | `qwen/qwen3.6-27b` | Transcription + written label + line range, one page per call |
| Mapping | `/api/map-answers` | `openai/gpt-oss-120b` | Label match in code, content match for the rest |
| Grading | `/api/grade` | `openai/gpt-oss-120b` | Per-question score and feedback, plus an overall summary |

The client orchestrates the stages rather than one long server call. Every
request stays well inside serverless time limits, and the progress UI has real
per-stage state to report.

### Screens

Four states, matching the Figma frames:

| Screen | Figma | Notes |
|---|---|---|
| Upload — empty / filled | `1:8744` / `1:8797` | Two dropzones; the filled card shows name, size and page count, read locally with pdf.js |
| Processing | `1:9959` | The design's loader, plus a six-segment stage indicator the frame has no equivalent for |
| Answer mapping | `1:8861` | Questions left, answer sheet right, regions drawn over the page |

Below 900px the sidebar becomes a drawer and the two panes become a
Questions / Answers toggle, matching the 393px phone frames.

---

## Working inside the Groq free tier

Measured against a live free key, the binding constraint is **8,000 tokens per
minute, per model** — not request count, which is 1,000/min. Three findings
shaped the implementation:

- **An image costs a flat ~1,805 prompt tokens regardless of pixel size.** There
  is no benefit to shrinking images further, and only one image per request fits
  alongside a useful output budget.
- **`max_completion_tokens` is reserved against the budget.** Groq's preflight
  rejects the request before the model runs, so an over-generous cap fails with a
  413. Every call sets a tight, deliberate cap.
- **Qwen 3.6 reasons by default, and reasoning tokens are spent before any JSON
  is emitted** — which surfaces as `json_validate_failed` with an empty
  completion. These are extraction tasks, so `reasoning_effort: "none"` costs
  nothing and fixes it.

`src/lib/groq.ts` therefore paces requests against a rolling per-model token
ledger, queuing callers so the ledger stays truthful under concurrency, and
treats 429s as a backstop rather than the mechanism.

**Consequence: a run is slow.** A 1-page paper plus a 3-page answer sheet takes
about 3–4 minutes, almost all of it waiting on the token budget. That is the free
tier, not the code. A paid key removes it — nothing else needs to change.

---

## Edge cases

| Requirement | How it is handled |
|---|---|
| Sub-parts as separate questions | `11 (a)` / `11 (b)` become distinct entries sharing a number, keyed `11a` / `11b` |
| Original numbering preserved | Never renumbered or gap-filled; sorted by page, then numeric value, then sub-part |
| Answers out of order | Mapping is by label and content; position is not used as evidence |
| Unanswered questions | Left unmapped, tagged "No answer mapped", scored 0 in code rather than by the model |
| Answers matching no question | Listed under the questions and drawn on the sheet as an "Unmapped" region; selecting one jumps to it |
| Multi-page answers | A question's blocks merge across pages into multiple regions |
| Illegible handwriting | Per-block confidence; low-confidence matches are flagged for review |
| Blank pages | Pages with no detected ink skip the model call entirely |

---

## Running it

```bash
npm install
cp .env.example .env.local     # add your Groq key from console.groq.com/keys
npm run dev
```

### Tests

The fixtures deliberately exercise the hard cases: answers written out of order
(Q5 before Q3), a question left unanswered (Q6), a note that answers nothing, and
an answer running across a page break (Q8 on pages 2→3).

```bash
npm run test:bands           # line segmentation against fixture pages, no API calls
npm run test:api             # full pipeline through the API routes (17 checks)
npm run test:browser         # real Chromium at 1440px: upload → highlight → feedback
npm run test:browser:pdf     # same, via the PDF path
npm run test:browser:mobile  # the 393px phone frames, incl. the Questions/Answers toggle
```

`test:bands` runs the real segmentation source through Node's type stripping, so
it exercises the same code the browser runs rather than a copy.

Latest run: **17/17** API checks, and **16/16** browser checks at both 1440px and
393px, on image and PDF inputs.

---

## Assumptions and limitations

- **Answers are written in horizontal lines.** Projection-profile segmentation
  assumes roughly horizontal text. A badly skewed scan degrades band accuracy;
  deskewing is not implemented.
- **Diagrams are highlighted as a block, and graded on their labels.** The model
  describes and transcribes a drawing, but marking the drawing itself is beyond
  what a text grade can honestly assess.
- **Two answers on the same line cannot be separated.** Bands are full-line; a
  page in two columns would need column detection first.
- **Grading is advisory.** Scores come from an LLM at low temperature and vary
  slightly between runs. The transcript and highlight are shown alongside every
  grade so a teacher can check the reasoning rather than trust it.
- **10MB per upload**, held in browser memory only. Nothing is persisted; there is
  no database and no authentication, per the brief.
- **Transcription drives grading.** A misread word is graded as written, though
  the prompt instructs the model not to penalise transcription noise or spelling.

## Model choice

| Task | Model | Why |
|---|---|---|
| Vision | `qwen/qwen3.6-27b` | The current vision model on Groq's free tier, with JSON mode. Llama 4 Scout was deprecated on 17 June 2026. |
| Text | `openai/gpt-oss-120b` | Fast, 131K context, ample for mapping and grading; no image cost. |

Both are overridable via `GROQ_VISION_MODEL` / `GROQ_TEXT_MODEL`.

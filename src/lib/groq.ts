import Groq from "groq-sdk";

/**
 * Groq wrapper built around the free tier's real constraint.
 *
 * Measured on a free key: 1000 requests/min but only 8000 tokens/min, per
 * model. Requests are cheap; tokens are scarce. Two consequences drive the
 * design here:
 *
 *  - An image costs a flat ~1805 prompt tokens whatever its pixel size, so
 *    there is no benefit to shrinking images further, and only one image per
 *    request fits comfortably.
 *  - max_completion_tokens is *reserved* against the budget by Groq's
 *    preflight check, so an over-generous cap fails the request outright with a
 *    413 before the model ever runs. Every call sets a tight, deliberate cap.
 *
 * So we pace ourselves against a rolling token ledger rather than firing
 * requests and hoping, and treat 429s as a backstop rather than the mechanism.
 */

export const VISION_MODEL = process.env.GROQ_VISION_MODEL ?? "qwen/qwen3.6-27b";
export const TEXT_MODEL = process.env.GROQ_TEXT_MODEL ?? "openai/gpt-oss-120b";

/** Free-tier tokens per minute, per model. */
const TPM = Number(process.env.GROQ_TPM ?? 8000);
/** Flat prompt cost of one image, measured against the API. */
export const IMAGE_TOKEN_COST = 1805;
/** One image per request: two would leave no room for a useful output budget. */
export const MAX_IMAGES_PER_REQUEST = 1;

let client: Groq | null = null;

export function getGroq(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it to .env.local (see .env.example).",
    );
  }
  client ??= new Groq({ apiKey, maxRetries: 0 });
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Token ledger                                                        */
/* ------------------------------------------------------------------ */

interface Spend {
  at: number;
  tokens: number;
}

const ledgers = new Map<string, Spend[]>();
/** Serialises the wait-and-reserve step so two callers cannot both think there is room. */
const gates = new Map<string, Promise<void>>();

function spentInWindow(model: string): number {
  const now = Date.now();
  const ledger = (ledgers.get(model) ?? []).filter((s) => now - s.at < 60_000);
  ledgers.set(model, ledger);
  return ledger.reduce((sum, s) => sum + s.tokens, 0);
}

/**
 * Wait until `tokens` fit inside this model's rolling minute, then record them.
 * Callers queue behind each other so the ledger stays truthful under concurrency.
 */
async function reserve(model: string, tokens: number): Promise<void> {
  const previous = gates.get(model) ?? Promise.resolve();

  const turn = previous.then(async () => {
    for (;;) {
      const spent = spentInWindow(model);
      if (spent + tokens <= TPM) break;

      // Wait for the oldest spend to age out of the window.
      const ledger = ledgers.get(model) ?? [];
      const oldest = ledger[0];
      const waitMs = oldest ? Math.max(250, 60_000 - (Date.now() - oldest.at) + 250) : 1000;
      await sleep(waitMs);
    }

    const ledger = ledgers.get(model) ?? [];
    ledger.push({ at: Date.now(), tokens });
    ledgers.set(model, ledger);
  });

  gates.set(
    model,
    turn.catch(() => undefined),
  );
  return turn;
}

/** Rough prompt-token estimate: ~4 characters per token, plus flat image cost. */
function estimatePromptTokens(system: string, content: MessageContent[]): number {
  let chars = system.length;
  let images = 0;

  for (const part of content) {
    if (part.type === "text") chars += part.text.length;
    else images++;
  }

  return Math.ceil(chars / 4) + images * IMAGE_TOKEN_COST + 200;
}

/* ------------------------------------------------------------------ */
/* JSON handling                                                       */
/* ------------------------------------------------------------------ */

/**
 * Strip prose/markdown fencing that models sometimes wrap around JSON, then
 * fall back to a brace-matched slice so a trailing sentence cannot break parsing.
 */
export function parseJsonLoose<T>(raw: string): T {
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    // fall through to brace matching
  }

  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`No JSON found in model output: ${raw.slice(0, 200)}`);

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
    }
  }

  throw new Error(`Unbalanced JSON in model output: ${raw.slice(0, 200)}`);
}

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface CompletionOptions {
  model: string;
  system: string;
  content: MessageContent[];
  /**
   * Output cap. Reserved against the token budget, so keep it just large enough
   * for the expected JSON - an inflated value fails the request preflight.
   */
  maxTokens: number;
  temperature?: number;
  attempts?: number;
}

function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: Record<string, string> })?.headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

/**
 * Turn thinking off.
 *
 * Qwen 3.6 reasons by default, and those reasoning tokens are spent from
 * max_completion_tokens before any JSON is emitted - which shows up as a
 * `json_validate_failed` with an empty completion. These are extraction tasks,
 * not reasoning ones, so thinking costs budget and buys nothing.
 */
function reasoningControls(model: string): Record<string, unknown> {
  if (model.startsWith("qwen/")) {
    return { reasoning_effort: "none", reasoning_format: "hidden" };
  }
  if (model.includes("gpt-oss")) {
    return { reasoning_effort: "low", include_reasoning: false };
  }
  return {};
}

/** Run one chat completion in JSON mode, paced against the token budget. */
export async function completeJson<T>(opts: CompletionOptions): Promise<T> {
  const { model, system, content, maxTokens, temperature = 0, attempts = 3 } = opts;

  const groq = getGroq();
  const cost = estimatePromptTokens(system, content) + maxTokens;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    await reserve(model, cost);

    try {
      const res = await groq.chat.completions.create({
        model,
        temperature,
        max_completion_tokens: maxTokens,
        response_format: { type: "json_object" },
        ...reasoningControls(model),
        messages: [
          { role: "system", content: system },
          { role: "user", content: content as never },
        ],
      });

      const raw = res.choices[0]?.message?.content ?? "";
      if (!raw.trim()) throw new Error("Empty completion from model");
      return parseJsonLoose<T>(raw);
    } catch (err) {
      lastError = err;
      const status = statusOf(err);

      // Client errors other than rate limiting will not fix themselves.
      const retriable =
        status === undefined || status === 429 || status === 413 || status === 408 || status >= 500;
      if (!retriable || attempt === attempts - 1) break;

      // A 429 despite the ledger means our estimate was low; wait it out.
      const wait = retryAfterMs(err) ?? Math.min(2 ** attempt * 2000, 20_000);
      await sleep(wait + Math.random() * 250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Map over items with a concurrency cap. Kept at 1 for vision work: the token
 * budget, not request count, is the bottleneck, so parallelism buys nothing and
 * only makes pacing harder to reason about.
 */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

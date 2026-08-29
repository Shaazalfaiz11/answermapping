import Groq from "groq-sdk";

/* ------------------------------------------------------------------ */
/* Diagnostic hook — zero cost when nothing subscribes                  */
/* ------------------------------------------------------------------ */

export interface GroqDiagnostic {
  model: string;
  estimatedCost: number;
  actualTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  status: "success" | "retry" | "error";
  httpStatus?: number;
  latencyMs: number;
  bucketBefore: number;
  bucketAfter: number;
}

const diagnosticHistory: GroqDiagnostic[] = [];
type DiagnosticListener = (d: GroqDiagnostic) => void;
const diagnosticListeners: DiagnosticListener[] = [];
export function onDiagnostic(fn: DiagnosticListener) { diagnosticListeners.push(fn); }
export function offDiagnostic(fn: DiagnosticListener) {
  const i = diagnosticListeners.indexOf(fn);
  if (i >= 0) diagnosticListeners.splice(i, 1);
}
function emitDiagnostic(d: GroqDiagnostic) {
  diagnosticHistory.push(d);
  for (const fn of diagnosticListeners) try { fn(d); } catch { /* listener crash must not break pipeline */ }
}
export function getCallHistory(): GroqDiagnostic[] { return [...diagnosticHistory]; }
export function clearCallHistory() { diagnosticHistory.length = 0; }

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

/**
 * The token budget is per model, and both Qwen builds are vision-capable with
 * their own independent 8,000/min allowance — verified by reading
 * `x-ratelimit-remaining-tokens` for each at the same instant. Spreading pages
 * across both therefore doubles the effective vision throughput rather than
 * queueing them all behind one bucket.
 */
export const VISION_MODELS: string[] = process.env.GROQ_VISION_MODEL
  ? [process.env.GROQ_VISION_MODEL]
  : ["qwen/qwen3.8-27b"];

/** Round-robin a unit of vision work onto one of the available buckets. */
export function visionModelFor(index: number): string {
  return VISION_MODELS[index % VISION_MODELS.length]!;
}

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

/** Expose ledger state for test/diagnostic purposes only. */
export function _inspectLedger(model: string): { spent: number; entries: number; tpm: number } {
  const spent = spentInWindow(model);
  return { spent, entries: (ledgers.get(model) ?? []).length, tpm: TPM };
}

/** Reset ledger for a model — test use only. */
export function _resetLedger(model: string) {
  ledgers.delete(model);
  gates.delete(model);
}

/**
 * Wait until `tokens` fit inside this model's rolling minute, then record them.
 * Callers queue behind each other so the ledger stays truthful under concurrency.
 *
 * Returns a `settle` callback. The reservation has to be made from an estimate,
 * because the budget must be claimed before the request goes out — but the
 * estimate includes the whole `max_completion_tokens` cap, and a typical call
 * uses well under half of it. Settling against `usage.total_tokens` hands the
 * difference straight back, which is worth roughly a 2x speed-up over holding
 * the pessimistic figure for the full minute.
 */
async function reserve(
  model: string,
  tokens: number,
  signal?: AbortSignal,
): Promise<(actual: number | null) => void> {
  const previous = gates.get(model) ?? Promise.resolve();

  const turn = previous.then(async () => {
    for (;;) {
      /*
       * A client that has gone away must not keep its place in the queue.
       * Serverless routes are not cancelled when the browser disconnects, so
       * without this an abandoned run leaves requests sleeping in front of
       * every later one - which is how a fresh run ends up waiting minutes on
       * a budget that is not actually being spent.
       */
      if (signal?.aborted) throw new Error("Request abandoned by the client");

      const spent = spentInWindow(model);
      if (spent + tokens <= TPM) break;

      /*
       * Re-check often rather than sleeping until the oldest entry ages out.
       * Budget no longer frees up only with the passage of time: an in-flight
       * call settling against its real usage releases the difference
       * immediately, and a single blind 60s sleep would sit through that and
       * waste most of a minute per request.
       */
      await sleep(400);
    }

    const ledger = ledgers.get(model) ?? [];
    const entry: Spend = { at: Date.now(), tokens };
    ledger.push(entry);
    ledgers.set(model, ledger);

    return (actual: number | null) => {
      // Never revise upwards past the reservation: the budget for anything
      // above it was never claimed, and pretending otherwise would let the
      // next caller through on a figure we did not hold.
      if (actual !== null && actual > 0) entry.tokens = Math.min(entry.tokens, actual);
      else entry.tokens = 0;
    };
  });

  gates.set(
    model,
    turn.then(
      () => undefined,
      () => undefined,
    ),
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
  /** Ties the call to the request, so a disconnect stops the wait. */
  signal?: AbortSignal;
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
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
  }
  // Groq TPD error message contains e.g. "Please try again in 12m45s" or "15m3s"
  const msg = (err as { message?: string })?.message ?? String(err ?? "");
  const match = msg.match(/try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (match) {
    const mins = Number(match[1] ?? 0);
    const secs = Number(match[2] ?? 0);
    return Math.ceil((mins * 60 + secs) * 1000);
  }
  return null;
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
  const {
    model,
    system,
    content,
    maxTokens,
    temperature = 0,
    attempts = 5,
    signal,
  } = opts;

  const groq = getGroq();
  const cost = estimatePromptTokens(system, content) + maxTokens;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const bucketBefore = spentInWindow(model);
    const settle = await reserve(model, cost, signal);
    let actualTokens: number | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    const t0 = Date.now();

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

      actualTokens = res.usage?.total_tokens ?? null;
      promptTokens = res.usage?.prompt_tokens ?? null;
      completionTokens = res.usage?.completion_tokens ?? null;

      const raw = res.choices[0]?.message?.content ?? "";
      if (!raw.trim()) throw new Error("Empty completion from model");
      const parsed = parseJsonLoose<T>(raw);

      settle(actualTokens);
      emitDiagnostic({
        model, estimatedCost: cost, actualTokens, promptTokens, completionTokens,
        status: "success", latencyMs: Date.now() - t0,
        bucketBefore, bucketAfter: spentInWindow(model),
      });
      return parsed;
    } catch (err) {
      lastError = err;
      const status = statusOf(err);

      // Client errors other than rate limiting will not fix themselves.
      const retriable =
        status === undefined || status === 429 || status === 413 || status === 408 || status >= 500;

      settle(actualTokens);
      emitDiagnostic({
        model, estimatedCost: cost, actualTokens, promptTokens, completionTokens,
        status: (!retriable || attempt === attempts - 1) ? "error" : "retry",
        httpStatus: status,
        latencyMs: Date.now() - t0,
        bucketBefore, bucketAfter: spentInWindow(model),
      });

      if (!retriable || attempt === attempts - 1) break;

      const rawWait = retryAfterMs(err);
      // If a model hits a 429 (quota exhaustion or TPD limit), try an alternative vision model if available
      const altModel = VISION_MODELS.find((m) => m !== model);
      if ((status === 429 || (rawWait !== null && rawWait > 5000)) && altModel && model.startsWith("qwen/")) {
        return completeJson<T>({ ...opts, model: altModel, attempts: attempts - attempt - 1 });
      }

      // Add 800ms safety padding so retry fires after Groq server window has reset
      const wait = rawWait ? rawWait + 800 : Math.min(2 ** attempt * 2000, 8000);
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

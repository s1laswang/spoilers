import OpenAI from "openai";

/**
 * One OpenAI client for the app, same shape as fr8-lab's lib/llm.ts.
 * gpt-6-luna: $0.10 / $0.50 per 1M tokens in / out, so a full 12-run match is a fraction of a cent.
 */
export const SIM_MODEL = process.env.SIM_MODEL ?? "gpt-6-luna";
export const SIM_EFFORT = (process.env.SIM_EFFORT ?? "low") as OpenAI.ReasoningEffort;

const PRICES: Record<string, [number, number, number]> = {
  "gpt-6-sol": [2, 0.2, 10],
  "gpt-6-luna": [0.1, 0.01, 0.5],
};

export const hasKey = () => Boolean(process.env.OPENAI_API_KEY);

/**
 * Next patches the global fetch with its caching layer, which can stall a
 * request inside a route handler; the SDK gets its own no-store fetch.
 */
let client: OpenAI | null = null;
export function openai(): OpenAI {
  client ??= new OpenAI({
    fetch: (input, init) =>
      fetch(input as RequestInfo, { ...(init as RequestInit), cache: "no-store" }),
    maxRetries: 1,
  });
  return client;
}

/** Profiles are personal data: nothing is kept on OpenAI's side. */
export const STATELESS = { store: false };

type Usage = OpenAI.Responses.ResponseUsage | undefined | null;

export function logUsage(label: string, model: string, u: Usage): void {
  if (!u) return;
  const p = PRICES[model];
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const usd = p
    ? ((u.input_tokens - cached) * p[0] + cached * p[1] + u.output_tokens * p[2]) / 1e6
    : 0;
  console.error(
    `[usage] ${label} model=${model} in=${u.input_tokens} cached=${cached} out=${u.output_tokens} reasoning=${u.output_tokens_details?.reasoning_tokens ?? 0} ~$${usd.toFixed(5)}`
  );
}

/** Status of the last failed call (401 bad key, 429 quota/rate), for /api/health. Never the key. */
export let lastErrorStatus: number | string | null = null;

/** One strict-JSON Responses call; returns the parsed object or throws. */
export async function jsonCall<T>(opts: {
  label: string;
  instructions: string;
  input: string;
  format: { type: "json_schema"; name: string; strict: true; schema: Record<string, unknown> };
  cacheKey: string;
  timeoutMs: number;
}): Promise<T> {
  const response = await openai().responses.create(
    {
      model: SIM_MODEL,
      instructions: opts.instructions,
      input: opts.input,
      text: { format: opts.format },
      reasoning: { effort: SIM_EFFORT },
      max_output_tokens: 4000,
      prompt_cache_key: opts.cacheKey,
      ...STATELESS,
    },
    { signal: AbortSignal.timeout(opts.timeoutMs) }
  ).catch((err: { status?: number; name?: string }) => {
    lastErrorStatus = err?.status ?? err?.name ?? "error";
    throw err;
  });
  logUsage(opts.label, SIM_MODEL, response.usage);
  const text = response.output_text?.trim();
  if (!text) throw new Error(`[${opts.label}] empty answer: status=${response.status}`);
  return JSON.parse(text) as T;
}

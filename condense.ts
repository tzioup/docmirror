import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CondenseResult {
  slug: string;
  status: "ok" | "fallback" | "error";
  wordsBefore: number;
  wordsAfter: number;
  reductionPct: number;
  error?: string;
}

export interface CondenseStats {
  total: number;
  condensed: number;
  fallback: number;
  errors: number;
  avgReductionPct: number;
}

export interface LlmConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

const API_TIMEOUT_MS = 60_000;
const SUBPROCESS_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 16_384;
const CONTAMINATION_PATTERN = /I don.t see the actual|I.m ready to tighten|ready to tighten your documentation|Please provide the documentation|However, I don.t see/i;
const SYSTEM_LEAK_PATTERN = /function calls using tools|invoke name=|parameter name=/i;

const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com";

// Aliases, not pinned snapshots. A date suffix has to be one the provider
// actually publishes — `claude-sonnet-4-6-20250514` was a constructed id that
// resolved to nothing, so `--condense-model sonnet` failed outright.
// Consequence worth knowing: an alias silently follows the provider's current
// snapshot, so the same flag can mean a different model month to month. That is
// the main reason the condense results in the README are indicative only.
const MODEL_SHORTCUTS: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
};

let cachedPrompt: string | null = null;

function getPrompt(): string {
  if (!cachedPrompt) {
    cachedPrompt = readFileSync(join(import.meta.dir, "prompts", "condense-page.md"), "utf-8");
  }
  return cachedPrompt;
}

function resolveModel(short: string): string {
  return MODEL_SHORTCUTS[short] ?? short;
}

function isAnthropicUrl(baseUrl: string): boolean {
  return baseUrl.includes("anthropic.com");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function countCodeBlocks(text: string): number {
  const fenceLines = text.split(/\r?\n/).filter((line) => /^```/.test(line)).length;
  return Math.floor(fenceLines / 2);
}

function countHeadings(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^#{2,6} /.test(line)).length;
}

function isContaminated(text: string): boolean {
  const firstLines = text.split(/\r?\n/).slice(0, 3).join("\n");
  return CONTAMINATION_PATTERN.test(firstLines) || SYSTEM_LEAK_PATTERN.test(firstLines);
}

function passesStructuralValidation(input: string, output: string): boolean {
  if (countCodeBlocks(output) < countCodeBlocks(input)) return false;
  if (countHeadings(output) < countHeadings(input)) return false;

  const inputWords = countWords(input);
  const outputWords = countWords(output);
  if (outputWords > inputWords * 1.05) return false;
  if (isContaminated(output)) return false;

  return true;
}

function computeReductionPct(wordsBefore: number, wordsAfter: number): number {
  if (wordsBefore === 0) return 0;
  return Number((((wordsBefore - wordsAfter) / wordsBefore) * 100).toFixed(2));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function extractAnthropicText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.content)) return null;

  const parts: string[] = [];
  for (const block of payload.content) {
    if (!isRecord(block) || typeof block.type !== "string") return null;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") return null;
    parts.push(block.text);
  }

  const text = parts.join("\n");
  return text.trim() ? text : null;
}

function extractOpenAIText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const first = payload.choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message) || typeof message.content !== "string") return null;
  return message.content.trim() ? message.content as string : null;
}

async function callAnthropicApi(
  content: string,
  model: string,
  prompt: string,
  apiKey: string,
  baseUrl: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: resolveModel(model),
        max_tokens: MAX_TOKENS,
        system: prompt,
        messages: [{ role: "user", content }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      process.stderr.write(`[condense] Anthropic API error: ${response.status} ${response.statusText}\n`);
      return null;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }

    return extractAnthropicText(payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatibleApi(
  content: string,
  model: string,
  prompt: string,
  apiKey: string,
  baseUrl: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      process.stderr.write(`[condense] LLM API error: ${response.status} ${response.statusText}\n`);
      return null;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }

    return extractOpenAIText(payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callApi(
  content: string,
  model: string,
  prompt: string,
  apiKey: string,
  baseUrl: string,
): Promise<string | null> {
  if (isAnthropicUrl(baseUrl)) {
    return callAnthropicApi(content, model, prompt, apiKey, baseUrl);
  }
  return callOpenAICompatibleApi(content, model, prompt, apiKey, baseUrl);
}

function getClaudeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") continue;
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

async function readStreamText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

async function callClaudeCli(content: string, model: string, prompt: string): Promise<string | null> {
  if (!Bun.which("claude")) return null;
  try {
    const subprocess = Bun.spawn(
      [
        "claude",
        "--print",
        "--model",
        model,
        "--output-format",
        "text",
        "--setting-sources",
        "",
        "--system-prompt",
        prompt,
        "--no-session-persistence",
      ],
      {
        stdin: new Blob([content]),
        stdout: "pipe",
        stderr: "pipe",
        env: getClaudeEnv(),
      },
    );

    const [exitCode, stdout] = await withTimeout(
      Promise.all([
        subprocess.exited,
        readStreamText(subprocess.stdout),
        readStreamText(subprocess.stderr),
      ]),
      SUBPROCESS_TIMEOUT_MS,
      () => {
        try {
          subprocess.kill();
        } catch {
          return;
        }
      },
    );

    if (exitCode !== 0) return null;
    return stdout.trim() ? stdout : null;
  } catch {
    return null;
  }
}

async function condensePageWithPrompt(
  content: string,
  llm: LlmConfig,
  prompt: string,
): Promise<string | null> {
  if (!content.trim()) return null;

  let condensed: string | null = null;

  if (llm.apiKey && llm.baseUrl) {
    condensed = await callApi(content, llm.model, prompt, llm.apiKey, llm.baseUrl);
  } else if (llm.apiKey) {
    condensed = await callApi(content, llm.model, prompt, llm.apiKey, ANTHROPIC_DEFAULT_URL);
  } else {
    condensed = await callClaudeCli(content, llm.model, prompt);
  }

  if (condensed === null) return null;
  if (!passesStructuralValidation(content, condensed)) return null;
  return condensed;
}

export async function condensePage(
  content: string,
  llm: LlmConfig,
): Promise<string | null> {
  try {
    return await condensePageWithPrompt(content, llm, getPrompt());
  } catch {
    return null;
  }
}

export async function condensePages(
  pages: Map<string, string>,
  opts: { llm: LlmConfig; concurrency: number },
): Promise<{
  results: Map<string, CondenseResult>;
  condensed: Map<string, string>;
  stats: CondenseStats;
}> {
  const results = new Map<string, CondenseResult>();
  const condensed = new Map<string, string>();
  const entries = Array.from(pages.entries());
  const total = entries.length;
  const concurrency = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 1;

  if (total === 0) {
    return {
      results,
      condensed,
      stats: { total: 0, condensed: 0, fallback: 0, errors: 0, avgReductionPct: 0 },
    };
  }

  let prompt: string;
  try {
    prompt = getPrompt();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const [slug, content] of entries) {
      const words = countWords(content);
      condensed.set(slug, content);
      results.set(slug, {
        slug,
        status: "error",
        wordsBefore: words,
        wordsAfter: words,
        reductionPct: 0,
        error: message,
      });
    }
    return {
      results,
      condensed,
      stats: { total, condensed: 0, fallback: 0, errors: total, avgReductionPct: 0 },
    };
  }

  let completed = 0;
  let condensedCount = 0;
  let fallbackCount = 0;
  let errorCount = 0;
  let reductionTotal = 0;
  let running = 0;
  const queue = [...entries];

  await new Promise<void>((resolve) => {
    function scheduleNext(): void {
      while (running < concurrency && queue.length > 0) {
        const entry = queue.shift()!;
        running++;
        processEntry(entry).then(() => {
          running--;
          completed++;
          process.stderr.write(`\r[condense] ${completed}/${total} pages condensed...`);
          if (queue.length === 0 && running === 0) {
            process.stderr.write("\n");
            resolve();
          } else {
            scheduleNext();
          }
        });
      }
    }

    async function processEntry([slug, content]: [string, string]): Promise<void> {
      const wordsBefore = countWords(content);

      try {
        const output = await condensePageWithPrompt(content, opts.llm, prompt);

        if (output === null) {
          condensed.set(slug, content);
          results.set(slug, {
            slug,
            status: "fallback",
            wordsBefore,
            wordsAfter: wordsBefore,
            reductionPct: 0,
          });
          fallbackCount++;
          return;
        }

        const wordsAfter = countWords(output);
        const reductionPct = computeReductionPct(wordsBefore, wordsAfter);

        condensed.set(slug, output);
        results.set(slug, {
          slug,
          status: "ok",
          wordsBefore,
          wordsAfter,
          reductionPct,
        });
        condensedCount++;
        reductionTotal += reductionPct;
      } catch (error) {
        condensed.set(slug, content);
        results.set(slug, {
          slug,
          status: "error",
          wordsBefore,
          wordsAfter: wordsBefore,
          reductionPct: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        errorCount++;
      }
    }

    scheduleNext();
  });

  return {
    results,
    condensed,
    stats: {
      total,
      condensed: condensedCount,
      fallback: fallbackCount,
      errors: errorCount,
      avgReductionPct: condensedCount === 0 ? 0 : Number((reductionTotal / condensedCount).toFixed(2)),
    },
  };
}

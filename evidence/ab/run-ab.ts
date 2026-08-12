#!/usr/bin/env bun
/**
 * A/B harness: does a local docmirror corpus beat fetching the docs live?
 *
 * Two arms answer the same frozen question set with the same model and the same
 * grader. Only the tool surface differs:
 *
 *   frontdoor — WebFetch + WebSearch, no local files      (what an agent does by default)
 *   cache     — Read + Grep + Glob over a corpus, no web  (what docmirror gives it)
 *
 * Telemetry is read from the runner's own JSON output, never self-reported by
 * the model: tokens, cost, wall-clock, turn count, and the count of web
 * fetches/searches the model actually performed.
 *
 * Usage:
 *   bun evidence/ab/run-ab.ts --corpora <dir> [--arm frontdoor|cache|memory] [--out <dir>]
 *
 * <dir> must contain one subdirectory per corpus named in questions.json, each
 * holding that corpus's compiled markdown as <name>/<name>.md. There is no
 * builder script — mirror each source, then copy the compiled file into place:
 *
 *   DOCMIRROR_OUTPUT=./runs bun docmirror.ts https://vitest.dev --name vitest
 *   mkdir -p corpora/vitest
 *   cp runs/vitest-docs-<stamp>/vitest-docs-compiled.md corpora/vitest/vitest.md
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const MODEL = "sonnet"; // resolves to claude-sonnet-5; recorded per-run from the runner's own output
const ARMS = ["frontdoor", "cache", "memory"] as const;
type Arm = (typeof ARMS)[number];

interface Question {
  id: string;
  corpus: string;
  question: string;
  source: string;
  all_of: string[];
}

interface RunRecord {
  arm: Arm;
  question_id: string;
  corpus: string;
  answer: string;
  error: string | null;
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
  web_fetches: number;
  web_searches: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  models_used: string[];
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

/**
 * The two arms differ ONLY in tool surface and the one orientation line that
 * tells each arm where its source of truth is. Everything else is held constant.
 */
function buildPrompt(arm: Arm, q: Question, corpusRelPath: string): string {
  const orientation =
    arm === "frontdoor"
      ? "You have web access. Consult the tool's official online documentation."
      : arm === "cache"
        ? `A local markdown mirror of the documentation is at ./${corpusRelPath}. Search it with grep and read it. You have no web access.`
        : "You have no tools and no access to the documentation. Answer from what you already know.";

  return [
    orientation,
    "",
    `Question: ${q.question}`,
    "",
    "Answer from the documentation, not from memory. Give the specific value(s) asked for.",
    "Keep the answer under 60 words. If you cannot find it, say NOT FOUND.",
  ].join("\n");
}

function toolFlags(arm: Arm): string[] {
  const denyAll = ["--disallowed-tools", "WebFetch", "WebSearch", "Read", "Grep", "Glob", "Bash", "Edit", "Write"];
  if (arm === "frontdoor") {
    return ["--allowed-tools", "WebFetch", "WebSearch", "--disallowed-tools", "Read", "Grep", "Glob", "Bash", "Edit", "Write"];
  }
  if (arm === "cache") {
    return ["--allowed-tools", "Read", "Grep", "Glob", "--disallowed-tools", "WebFetch", "WebSearch", "Bash", "Edit", "Write"];
  }
  // memory: the control arm. No tools at all, so its score is the share of the
  // question set answerable from pretraining alone. Without it, two arms tying
  // on accuracy is uninterpretable — it could mean both sources worked, or that
  // neither was ever consulted.
  return denyAll;
}

/** Strip the vars that make a nested Claude Code invocation refuse to start. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k === "CLAUDE_CODE_SSE_PORT" || k === "CLAUDE_CODE_ENTRYPOINT") continue;
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

function pickNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function runOne(arm: Arm, q: Question, cwd: string, corpusRelPath: string): Promise<RunRecord> {
  const args = [
    "claude",
    "--print",
    "--model",
    MODEL,
    "--output-format",
    "json",
    // Removes the operator's own settings files from the run, so a result is not
    // a fact about one machine's configuration. See METHODOLOGY.md.
    "--setting-sources",
    "",
    "--no-session-persistence",
    // No --permission-mode: the explicit --allowed-tools list is the grant, and
    // bypassPermissions maps to --dangerously-skip-permissions, which refuses to
    // run as root and would fail every call in a container.
    ...toolFlags(arm),
  ];

  const proc = Bun.spawn(args, {
    cwd,
    stdin: new Blob([buildPrompt(arm, q, corpusRelPath)]),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });

  const [, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const base: RunRecord = {
    arm,
    question_id: q.id,
    corpus: q.corpus,
    answer: "",
    error: null,
    duration_ms: 0,
    total_cost_usd: 0,
    num_turns: 0,
    web_fetches: 0,
    web_searches: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    models_used: [],
  };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { ...base, error: `unparseable runner output: ${stderr.slice(0, 300) || stdout.slice(0, 300)}` };
  }

  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const serverToolUse = (usage.server_tool_use ?? {}) as Record<string, unknown>;
  const modelUsage = (payload.modelUsage ?? {}) as Record<string, unknown>;

  return {
    ...base,
    answer: typeof payload.result === "string" ? payload.result : "",
    error: payload.is_error === true ? String(payload.result ?? "runner reported is_error") : null,
    duration_ms: pickNumber(payload.duration_ms) || pickNumber(payload.duration_api_ms),
    total_cost_usd: pickNumber(payload.total_cost_usd),
    num_turns: pickNumber(payload.num_turns),
    web_fetches: pickNumber(serverToolUse.web_fetch_requests),
    web_searches: pickNumber(serverToolUse.web_search_requests),
    input_tokens: pickNumber(usage.input_tokens),
    output_tokens: pickNumber(usage.output_tokens),
    cache_creation_input_tokens: pickNumber(usage.cache_creation_input_tokens),
    cache_read_input_tokens: pickNumber(usage.cache_read_input_tokens),
    models_used: Object.keys(modelUsage),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corporaRoot = args.corpora ? resolve(args.corpora) : null;
  if (!corporaRoot) {
    process.stderr.write("error: --corpora <dir> is required\n");
    process.exit(2);
  }

  const outDir = resolve(args.out ?? join(import.meta.dir, "runs"));
  await mkdir(outDir, { recursive: true });

  const spec = JSON.parse(await readFile(join(import.meta.dir, "questions.json"), "utf8")) as {
    version: string;
    questions: Question[];
  };

  const arms: Arm[] = args.arm ? [args.arm as Arm] : [...ARMS];
  for (const arm of arms) {
    if (!ARMS.includes(arm)) {
      process.stderr.write(`error: unknown arm "${arm}"\n`);
      process.exit(2);
    }
  }

  // Check the corpora exist BEFORE spending anything. Without this the cache arm
  // runs happily against an empty directory: the model reports it cannot find the
  // file, every answer misses the key, and the run lands as a clean `0/10` with
  // `runner_errors: 0` — a result indistinguishable from "the corpus did not
  // help", for a full 10-question arm's worth of real money. It reads as evidence
  // against the tool, which is the most expensive way for a harness to be wrong.
  if (arms.includes("cache")) {
    const needed = [...new Set(spec.questions.map((q) => q.corpus))];
    const missing: string[] = [];
    for (const corpus of needed) {
      const p = join(corporaRoot, corpus, `${corpus}.md`);
      if (!(await Bun.file(p).exists())) missing.push(p);
    }
    if (missing.length) {
      process.stderr.write(
        `error: the cache arm needs ${needed.length} corpus file(s) and ${missing.length} are absent:\n` +
          missing.map((m) => `  ${m}\n`).join("") +
          "\nBuild each one before running, or the arm scores 0 for a reason that has\n" +
          "nothing to do with the corpus:\n" +
          "  DOCMIRROR_OUTPUT=./runs bun docmirror.ts <url> --name <corpus>\n" +
          "  mkdir -p <corpora>/<corpus>\n" +
          "  cp runs/<corpus>-docs-*/<corpus>-docs-compiled.md <corpora>/<corpus>/<corpus>.md\n",
      );
      process.exit(1);
    }
  }

  const records: RunRecord[] = [];
  for (const arm of arms) {
    // The front-door arm runs from a directory with no corpus in it, so a local
    // read is not merely disallowed by flag — there is nothing there to read.
    const cwd = arm === "cache" ? corporaRoot : outDir;
    for (const q of spec.questions) {
      const corpusRelPath = `${q.corpus}/${q.corpus}.md`;
      process.stderr.write(`[${arm}] ${q.id} ... `);
      const rec = await runOne(arm, q, cwd, corpusRelPath);
      records.push(rec);
      process.stderr.write(
        rec.error
          ? `ERROR (${rec.error.slice(0, 80)})\n`
          : `${(rec.duration_ms / 1000).toFixed(1)}s $${rec.total_cost_usd.toFixed(4)} turns=${rec.num_turns}\n`,
      );
    }
  }

  const outPath = join(outDir, `raw-${arms.join("+")}.json`);
  await writeFile(
    outPath,
    JSON.stringify({ question_set_version: spec.version, model_requested: MODEL, records }, null, 2),
  );
  process.stderr.write(`\nwrote ${records.length} records → ${outPath}\n`);
}

await main();

#!/usr/bin/env bun
/**
 * Deterministic grader for the A/B harness.
 *
 * An answer passes only if every regex in the question's `all_of` key matches
 * it, case-insensitively. There is no model in the grading path, so re-running
 * the grader on the same raw records always yields the same score.
 *
 * Usage: bun evidence/ab/grade.ts <raw.json> [<raw.json> ...]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Question {
  id: string;
  corpus: string;
  question: string;
  all_of: string[];
}

interface RunRecord {
  arm: string;
  question_id: string;
  answer: string;
  error: string | null;
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
  web_fetches: number;
  web_searches: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  models_used: string[];
}

function grade(answer: string, patterns: string[]): { pass: boolean; missing: string[] } {
  const missing = patterns.filter((p) => !new RegExp(p, "i").test(answer));
  return { pass: missing.length === 0, missing };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write("usage: bun grade.ts <raw.json> [...]\n");
    process.exit(2);
  }

  const spec = JSON.parse(await readFile(join(import.meta.dir, "questions.json"), "utf8")) as {
    version: string;
    questions: Question[];
  };
  const byId = new Map(spec.questions.map((q) => [q.id, q]));

  const records: RunRecord[] = [];
  for (const f of files) {
    const parsed = JSON.parse(await readFile(f, "utf8")) as { records: RunRecord[] };
    records.push(...parsed.records);
  }

  const arms = [...new Set(records.map((r) => r.arm))].sort();
  const perQuestion: Array<Record<string, unknown>> = [];
  const summary: Record<string, unknown> = {};

  for (const arm of arms) {
    const armRecs = records.filter((r) => r.arm === arm);
    const graded = armRecs.map((r) => {
      const q = byId.get(r.question_id);
      if (!q) return { rec: r, pass: false, missing: ["<question not in key>"] };
      const g = r.error ? { pass: false, missing: ["<runner error>"] } : grade(r.answer, q.all_of);
      return { rec: r, ...g };
    });

    for (const g of graded) {
      perQuestion.push({
        arm,
        question_id: g.rec.question_id,
        pass: g.pass,
        missing: g.missing,
        duration_s: Number((g.rec.duration_ms / 1000).toFixed(1)),
        cost_usd: Number(g.rec.total_cost_usd.toFixed(4)),
        turns: g.rec.num_turns,
        web_calls: g.rec.web_fetches + g.rec.web_searches,
        answer: g.rec.answer.replace(/\s+/g, " ").trim().slice(0, 240),
      });
    }

    const durations = graded.map((g) => g.rec.duration_ms / 1000);
    const costs = graded.map((g) => g.rec.total_cost_usd);
    // The first call of an arm pays a one-off prompt-cache write for the system
    // prompt; later calls read it. Reporting both keeps a 20-question run from
    // looking cheaper per question than a 2-question one for no real reason.
    const cacheWrite = graded.filter((g) => g.rec.cache_creation_input_tokens > 0).length;

    summary[arm] = {
      n: graded.length,
      passed: graded.filter((g) => g.pass).length,
      accuracy: Number((graded.filter((g) => g.pass).length / graded.length).toFixed(3)),
      runner_errors: graded.filter((g) => g.rec.error).length,
      total_cost_usd: Number(sum(costs).toFixed(4)),
      median_cost_usd: Number(median(costs).toFixed(4)),
      total_duration_s: Number(sum(durations).toFixed(1)),
      median_duration_s: Number(median(durations).toFixed(1)),
      total_turns: sum(graded.map((g) => g.rec.num_turns)),
      total_web_calls: sum(graded.map((g) => g.rec.web_fetches + g.rec.web_searches)),
      calls_that_wrote_prompt_cache: cacheWrite,
      models_used: [...new Set(graded.flatMap((g) => g.rec.models_used))].sort(),
    };
  }

  process.stdout.write(
    JSON.stringify({ question_set_version: spec.version, summary, per_question: perQuestion }, null, 2) + "\n",
  );
}

await main();

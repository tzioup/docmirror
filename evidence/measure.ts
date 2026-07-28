#!/usr/bin/env bun
/**
 * Corpus size measurement for docmirror runs.
 *
 * Produces two independent figures, because they answer different questions and
 * blending them would misrepresent both:
 *
 *   1. PIPELINE DELTA — bytes docmirror fetched vs bytes it emitted. This is only
 *      a compression claim on the HTML strip path. On the `/llms-full.txt` fast
 *      path docmirror performs no stripping at all, so the delta is ~0 by design
 *      and is reported as "n/a (fast path)" rather than as a 0% reduction.
 *
 *   2. FRONT-DOOR COST — what the same documentation costs an agent that fetches
 *      it live. A sample of real documentation URLs is fetched as raw HTML and
 *      measured, then compared against the mirrored markdown for the same page
 *      count. This is the figure that holds for every source regardless of path,
 *      and it is the one a reader actually cares about.
 *
 * Usage:
 *   bun evidence/measure.ts --runs <dir> [--sample 10] [--out evidence/results]
 *
 * <dir> is a directory of docmirror output directories (DOCMIRROR_OUTPUT).
 *
 * Network note: where Bun's native fetch cannot reach the network (some sandboxes
 * route egress through a proxy Bun does not use), preload the curl shim:
 *   bun --preload ./evidence/lib/curl-fetch-shim.ts evidence/measure.ts ...
 */

import { readdir, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";

const HTML_SAMPLE_DEFAULT = 10;
const FETCH_TIMEOUT_MS = 45_000;

interface RunJson {
  name?: string;
  url?: string;
  discoveryMethod?: string;
  tokenEstimate?: number;
  config?: { url?: string; name?: string; smart?: string; topN?: number };
  pages?: Array<{ url?: string; status?: string }>;
  startedAt?: string;
  completedAt?: string;
}

interface SourceMeasurement {
  name: string;
  url: string | null;
  discovery_method: string | null;
  fast_path: boolean;
  pages_fetched: number;
  raw_bytes: number;
  clean_bytes: number;
  clean_files: number;
  compiled_bytes: number;
  compiled_tokens_est: number;
  compiled_tokens_source: string;
  smart_query: string | null;
  smart_top_n: number | null;
  pipeline_reduction_pct: number | null;
  elapsed_s: number | null;
  elapsed_note: string | null;
  sitemap_page_count: number | null;
  html_sample_n: number;
  html_sample_bytes: number;
  html_mean_bytes_per_page: number | null;
  markdown_mean_bytes_per_page: number | null;
  front_door_ratio: number | null;
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
    } else out[key] = "true";
  }
  return out;
}

async function dirBytes(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { bytes: 0, files: 0 };
  }
  for (const e of entries) {
    const p = join(dir, e);
    const s = await stat(p);
    if (s.isDirectory()) {
      const sub = await dirBytes(p);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += s.size;
      files += 1;
    }
  }
  return { bytes, files };
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** docmirror stamps `> N pages | ~X tokens` into every compiled file's header. */
async function compiledHeaderTokens(path: string): Promise<number | null> {
  try {
    const head = (await readFile(path, "utf8")).slice(0, 2048);
    const m = head.match(/~([\d,]+)\s+tokens/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Documentation URLs from the site's own sitemap — the set an agent would browse. */
async function sitemapUrls(root: string): Promise<string[]> {
  const origin = new URL(root).origin;
  for (const candidate of [`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`, `${root.replace(/\/$/, "")}/sitemap.xml`]) {
    const xml = await fetchText(candidate);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    // A sitemap index points at more sitemaps; follow the first one.
    if (locs.length && locs.every((l) => l.endsWith(".xml"))) {
      const inner = await fetchText(locs[0]);
      if (!inner) continue;
      const innerLocs = [...inner.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      if (innerLocs.length) return innerLocs.filter((u) => !u.endsWith(".xml"));
    }
    if (locs.length) return locs.filter((u) => !u.endsWith(".xml"));
  }
  return [];
}

/**
 * Fallback page index for sites that publish no sitemap. `/llms.txt` is a
 * link list the site maintains itself, so it is a legitimate page enumeration
 * rather than an estimate — VitePress sites (hono, vitest) ship it and no sitemap.
 */
async function llmsTxtUrls(root: string): Promise<string[]> {
  const origin = new URL(root).origin;
  for (const candidate of [`${root.replace(/\/$/, "")}/llms.txt`, `${origin}/llms.txt`]) {
    const txt = await fetchText(candidate);
    if (!txt) continue;
    const hrefs = [...txt.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]);
    const urls = hrefs
      .map((h) => {
        try {
          // Links may be relative to the site root.
          const abs = new URL(h, origin);
          // An llms.txt often points at the `.md` variant of each page. Fetching
          // that would measure markdown and report it as the HTML cost, which
          // understates the front door — strip the suffix to get the real page.
          abs.pathname = abs.pathname.replace(/\.md$/, "");
          return abs.toString();
        } catch {
          return null;
        }
      })
      .filter((u): u is string => u !== null)
      // The index itself lists the bulk text files; they are not doc pages.
      .filter((u) => !/llms(-\w+)?\.txt$/.test(u));
    if (urls.length) return [...new Set(urls)];
  }
  return [];
}

/** Deterministic spread across the list — not random, so re-runs are comparable. */
function evenSample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]);
}

async function measureSource(runDir: string, sampleN: number): Promise<SourceMeasurement | null> {
  const runJsonPath = join(runDir, "run.json");
  let run: RunJson;
  try {
    run = JSON.parse(await readFile(runJsonPath, "utf8")) as RunJson;
  } catch {
    return null;
  }

  const name = run.name ?? run.config?.name ?? basename(runDir).replace(/-docs-\d{8}-\d{6}$/, "");
  const url = run.url ?? run.config?.url ?? null;
  const method = run.discoveryMethod ?? null;
  const fastPath = method === "llms-full-txt";

  const raw = await dirBytes(join(runDir, "pages"));
  const clean = await dirBytes(join(runDir, "clean"));
  const compiledPath = join(runDir, `${name}-docs-compiled.md`);
  const compiledBytes = await fileBytes(compiledPath);

  // Use docmirror's own token estimate. A ~4-chars-per-token approximation was
  // used here previously and disagreed with the tool by 43-65% — compile.ts
  // weights prose, code and CJK differently (1.33 / 2.0 / 1.5 per word) rather
  // than dividing bytes. Publishing a second, different number for the same file
  // gives a reader sizing a context budget no way to choose. Falls back to the
  // crude estimate only when the field is absent, and says so.
  // Read it from the compiled file's own header first — every run writes
  // `> N pages | ~X tokens` there, including ones whose manifest predates
  // `tokenEstimate` being recorded on the fast path.
  const headerTokens = await compiledHeaderTokens(compiledPath);
  const toolTokens = headerTokens ?? (typeof run.tokenEstimate === "number" ? run.tokenEstimate : null);
  const compiledTokens = toolTokens ?? Math.round(compiledBytes / 4);

  const pagesFetched = Array.isArray(run.pages) ? run.pages.length : raw.files;

  // `--smart <query> --top N` prunes the compiled file to the N best-matching
  // pages. When it is on, `compiled_bytes` describes that subset while every
  // other column describes the whole site — so it has to travel with the number
  // or the corpus total reads as "the entire docs mirror to this size".
  const smart = typeof run.config?.smart === "string" ? run.config.smart : null;
  const topN = smart ? (typeof run.config?.topN === "number" ? run.config.topN : null) : null;

  // Guard against manifests written before `startedAt` was stamped at run start.
  // Those recorded manifest-assembly time, so a 2085-page crawl that really took
  // 12m14s reports 0.002s. A sub-second duration across more than one fetched
  // page is not a duration; report nothing rather than a plausible-looking lie.
  const rawElapsed =
    run.startedAt && run.completedAt
      ? (new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
      : null;
  const elapsedUnreliable = rawElapsed !== null && rawElapsed < 1 && pagesFetched > 1;
  const elapsed = elapsedUnreliable ? null : rawElapsed;

  // Strip delta must compare the SAME page set on both sides. The compiled file
  // is post-`--smart`, so measuring raw → compiled on a pruned run reports the
  // pruning as if it were compression: astro dropped 1928 pages to 40, which
  // read as "96.7% reduction" and was nothing of the kind. raw → clean is
  // stripping alone, over identical pages.
  const inputBytes = raw.bytes;
  const reduction =
    !fastPath && inputBytes > 0 && clean.bytes > 0
      ? Number((((inputBytes - clean.bytes) / inputBytes) * 100).toFixed(1))
      : null;

  let sitemapCount: number | null = null;
  let sampleBytes = 0;
  let sampled = 0;
  if (url) {
    let urls = await sitemapUrls(url);
    if (!urls.length) urls = await llmsTxtUrls(url);
    if (urls.length) {
      // Restrict to pages under the documentation root where the root has a path,
      // so a marketing homepage does not distort the per-page HTML figure.
      const rootPath = new URL(url).pathname.replace(/\/$/, "");
      const docUrls = rootPath && rootPath !== "" ? urls.filter((u) => new URL(u).pathname.startsWith(rootPath)) : urls;
      const pool = docUrls.length >= sampleN ? docUrls : urls;
      sitemapCount = pool.length;
      for (const u of evenSample(pool, sampleN)) {
        const html = await fetchText(u);
        if (html === null) continue;
        sampleBytes += Buffer.byteLength(html, "utf8");
        sampled += 1;
      }
    }
  }

  const htmlMean = sampled > 0 ? Math.round(sampleBytes / sampled) : null;
  // Per-page mirrored size, measured over the pages that were actually mirrored.
  // On the strip path that is clean/ (one file per page). On the fast path there
  // is no per-page split — one file covers the whole site — so the site's own
  // page count is the right divisor there and only there. Using the site count
  // for a `--smart` run divides a 40-page corpus by a 417-page site and
  // overstates the ratio by an order of magnitude.
  const mdMean = fastPath
    ? sitemapCount && sitemapCount > 0 && compiledBytes > 0
      ? Math.round(compiledBytes / sitemapCount)
      : null
    : clean.files > 0 && clean.bytes > 0
      ? Math.round(clean.bytes / clean.files)
      : null;
  const ratio = htmlMean && mdMean ? Number((htmlMean / mdMean).toFixed(1)) : null;

  return {
    name,
    url,
    discovery_method: method,
    fast_path: fastPath,
    pages_fetched: pagesFetched,
    raw_bytes: raw.bytes,
    clean_bytes: clean.bytes,
    clean_files: clean.files,
    compiled_bytes: compiledBytes,
    compiled_tokens_est: compiledTokens,
    compiled_tokens_source:
      headerTokens !== null
        ? "docmirror (compiled file header)"
        : toolTokens !== null
          ? "docmirror (run.json)"
          : "bytes/4 approximation — no tool figure found",
    smart_query: smart,
    smart_top_n: topN,
    pipeline_reduction_pct: reduction,
    elapsed_s: elapsed,
    elapsed_note: elapsedUnreliable
      ? "discarded — manifest predates the fix that stamps startedAt at run start, so it timed manifest assembly, not the run"
      : null,
    sitemap_page_count: sitemapCount,
    html_sample_n: sampled,
    html_sample_bytes: sampleBytes,
    html_mean_bytes_per_page: htmlMean,
    markdown_mean_bytes_per_page: mdMean,
    front_door_ratio: ratio,
  };
}

function kb(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

function renderMarkdown(rows: SourceMeasurement[]): string {
  const out: string[] = [];

  out.push("### Front-door cost vs mirrored corpus");
  out.push("");
  out.push("| Source | Doc pages | Mean HTML page | Mean mirrored page | Ratio | Corpus total | Est. tokens |");
  out.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    // A pruned run's corpus total describes the kept subset, not the site. Mark
    // it in the cell rather than in a note under the table, because the number
    // is what gets quoted.
    const pruned = r.smart_top_n !== null ? ` ¹` : "";
    out.push(
      `| ${r.name} | ${r.sitemap_page_count ?? "—"} | ${r.html_mean_bytes_per_page ? kb(r.html_mean_bytes_per_page) : "—"} | ${
        r.markdown_mean_bytes_per_page ? kb(r.markdown_mean_bytes_per_page) : "—"
      } | ${r.front_door_ratio ? `${r.front_door_ratio}×` : "—"} | ${kb(r.compiled_bytes)}${pruned} | ${r.compiled_tokens_est.toLocaleString()}${pruned} |`,
    );
  }
  out.push("");
  const prunedRows = rows.filter((r) => r.smart_top_n !== null);
  if (prunedRows.length) {
    out.push(
      `¹ Run with \`--smart … --top N\`, so **Corpus total** and **Est. tokens** describe the kept subset, not the whole site — ` +
        prunedRows.map((r) => `${r.name} kept ${r.smart_top_n} of ${r.clean_files} stripped pages`).join("; ") +
        `. Every other column, including the ratio, is measured over the full page set.`,
    );
    out.push("");
  }
  out.push("### Pipeline delta (bytes fetched → bytes emitted)");
  out.push("");
  out.push("| Source | Discovery | Pages stripped | Raw | Stripped | Reduction |");
  out.push("|---|---|---:|---:|---:|---:|");
  for (const r of rows) {
    out.push(
      `| ${r.name} | \`${r.discovery_method ?? "—"}\` | ${r.fast_path ? "—" : r.clean_files} | ${
        r.raw_bytes ? kb(r.raw_bytes) : "—"
      } | ${r.clean_bytes ? kb(r.clean_bytes) : "—"} | ${
        r.fast_path ? "n/a — fast path, no stripping" : r.pipeline_reduction_pct !== null ? `${r.pipeline_reduction_pct}%` : "—"
      } |`,
    );
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runs) {
    process.stderr.write("error: --runs <dir> is required\n");
    process.exit(2);
  }
  const runsRoot = resolve(args.runs);
  const sampleN = Number(args.sample ?? HTML_SAMPLE_DEFAULT);
  const outDir = resolve(args.out ?? join(import.meta.dir, "results"));
  await mkdir(outDir, { recursive: true });

  const entries = await readdir(runsRoot);
  const rows: SourceMeasurement[] = [];
  const seen = new Set<string>();
  // Newest run wins when a source was mirrored more than once.
  for (const e of entries.sort().reverse()) {
    const p = join(runsRoot, e);
    if (!(await stat(p)).isDirectory()) continue;
    process.stderr.write(`measuring ${e} ... `);
    const m = await measureSource(p, sampleN);
    if (!m) {
      process.stderr.write("skipped (no run.json)\n");
      continue;
    }
    if (seen.has(m.name)) {
      process.stderr.write("skipped (older duplicate)\n");
      continue;
    }
    seen.add(m.name);
    rows.push(m);
    process.stderr.write(`ok (${m.html_sample_n} html pages sampled)\n`);
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  // Refuse to write a result that measured nothing. The default --out is the
  // committed evidence directory, and the network work here fails soft (a
  // sitemap that will not fetch yields a null ratio, not an error), so an empty
  // runs directory or a dead proxy previously overwrote the repo's only
  // evidence with a table of dashes and exited 0. Destroying data and reporting
  // success is worse than either destroying it loudly or not running.
  const usable = rows.filter((r) => r.front_door_ratio !== null);
  if (rows.length === 0) {
    process.stderr.write(`\nerror: no docmirror runs found under ${runsRoot} — nothing written.\n`);
    process.stderr.write("       --runs wants a directory OF run directories (DOCMIRROR_OUTPUT), not one run.\n");
    process.exit(1);
  }
  if (usable.length === 0) {
    process.stderr.write(
      `\nerror: ${rows.length} run(s) found but not one produced a front-door ratio — nothing written.\n` +
        "       Every HTML sample fetch failed. If Bun's fetch cannot reach the network here, preload the\n" +
        "       curl shim: bun --preload ./evidence/lib/curl-fetch-shim.ts evidence/measure.ts ...\n",
    );
    process.exit(1);
  }
  if (usable.length < rows.length) {
    process.stderr.write(
      `\nwarning: ${rows.length - usable.length} of ${rows.length} source(s) produced no front-door ratio; ` +
        "their rows will read '—'.\n",
    );
  }

  await writeFile(join(outDir, "corpus-sizes.json"), JSON.stringify({ sample_n: sampleN, sources: rows }, null, 2));
  await writeFile(join(outDir, "corpus-sizes.md"), renderMarkdown(rows) + "\n");
  process.stdout.write(renderMarkdown(rows) + "\n");
  process.stderr.write(`\nwrote ${rows.length} sources → ${outDir}\n`);
}

await main();

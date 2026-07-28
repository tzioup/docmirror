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
  config?: { url?: string; name?: string };
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
  compiled_bytes: number;
  compiled_tokens_est: number;
  pipeline_reduction_pct: number | null;
  elapsed_s: number | null;
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

  // docmirror's own compile step reports a token estimate; recompute the same
  // way (~4 chars/token) rather than importing it, so this file stays standalone.
  const compiledTokens = Math.round(compiledBytes / 4);

  const pagesFetched = Array.isArray(run.pages) ? run.pages.length : raw.files;

  const elapsed =
    run.startedAt && run.completedAt
      ? (new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
      : null;

  // Pipeline delta is only meaningful when stripping actually ran.
  const inputBytes = raw.bytes;
  const reduction =
    !fastPath && inputBytes > 0 && compiledBytes > 0
      ? Number((((inputBytes - compiledBytes) / inputBytes) * 100).toFixed(1))
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
  const mdMean = sitemapCount && sitemapCount > 0 && compiledBytes > 0 ? Math.round(compiledBytes / sitemapCount) : null;
  const ratio = htmlMean && mdMean ? Number((htmlMean / mdMean).toFixed(1)) : null;

  return {
    name,
    url,
    discovery_method: method,
    fast_path: fastPath,
    pages_fetched: pagesFetched,
    raw_bytes: raw.bytes,
    clean_bytes: clean.bytes,
    compiled_bytes: compiledBytes,
    compiled_tokens_est: compiledTokens,
    pipeline_reduction_pct: reduction,
    elapsed_s: elapsed,
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
    out.push(
      `| ${r.name} | ${r.sitemap_page_count ?? "—"} | ${r.html_mean_bytes_per_page ? kb(r.html_mean_bytes_per_page) : "—"} | ${
        r.markdown_mean_bytes_per_page ? kb(r.markdown_mean_bytes_per_page) : "—"
      } | ${r.front_door_ratio ? `${r.front_door_ratio}×` : "—"} | ${kb(r.compiled_bytes)} | ${r.compiled_tokens_est.toLocaleString()} |`,
    );
  }
  out.push("");
  out.push("### Pipeline delta (bytes fetched → bytes emitted)");
  out.push("");
  out.push("| Source | Discovery | Fetched | Emitted | Reduction |");
  out.push("|---|---|---:|---:|---:|");
  for (const r of rows) {
    out.push(
      `| ${r.name} | \`${r.discovery_method ?? "—"}\` | ${r.raw_bytes ? kb(r.raw_bytes) : "—"} | ${kb(r.compiled_bytes)} | ${
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
  await writeFile(join(outDir, "corpus-sizes.json"), JSON.stringify({ sample_n: sampleN, sources: rows }, null, 2));
  await writeFile(join(outDir, "corpus-sizes.md"), renderMarkdown(rows) + "\n");
  process.stdout.write(renderMarkdown(rows) + "\n");
  process.stderr.write(`\nwrote ${rows.length} sources → ${outDir}\n`);
}

await main();

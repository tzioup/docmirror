#!/usr/bin/env bun

import { Command } from "commander";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { discover } from "./discover.ts";
import { fetchPages } from "./fetch.ts";
import { detectPlatform } from "./detect.ts";
import { stripPages } from "./strip.ts";
import { validate } from "./validate.ts";
import { compile, estimateTokens } from "./compile.ts";
import { postcompile } from "./postcompile.ts";
import { initManifest, addPageResult, saveManifest, loadManifest, getResumeState, computeQualitySummary, summarizeExclusions, formatExclusionBreakdown } from "./state.ts";
import { smartPrune } from "./smart.ts";
import { condensePages } from "./condense.ts";
import type { RunConfig } from "./types.ts";

const VERSION = "1.0.0";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveNameFromUrl(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^(www|docs)\./, "");
  const firstPath = u.pathname.split("/").filter(Boolean)[0];
  const parts = [host.split(".")[0]];
  if (firstPath && firstPath !== "docs") parts.push(firstPath);
  return slugify(parts.join("-"));
}

function buildOutputDir(name: string): string {
  const baseDir = process.env.DOCMIRROR_OUTPUT ?? "./output";
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `${baseDir}/${slugify(name)}-docs-${date}-${time}`;
}

function log(msg: string): void {
  process.stderr.write(`[docmirror] ${msg}\n`);
}

async function mirrorCommand(url: string, opts: Record<string, unknown>): Promise<void> {
  // Taken here, not where the manifest is built — see initManifest's startedAt.
  const runStartedAt = new Date().toISOString();
  const name = (opts.name as string) || deriveNameFromUrl(url);
  const outputDir = buildOutputDir(name);

  const config: RunConfig = {
    url,
    name,
    outputDir,
    lang: (opts.lang as string) || "en",
    excludePaths: opts.excludePath ? (opts.excludePath as string).split(",") : [],
    forceMap: !!opts.forceMap,
    maxPages: opts.maxPages ? Number(opts.maxPages) : undefined,
    smart: opts.smart as string | undefined,
    filter: opts.filter as string | undefined,
    condense: !!opts.condense,
    condenseModel: (opts.condenseModel as string) || process.env.DOCMIRROR_LLM_MODEL || "haiku",
    condenseConcurrency: opts.condenseConcurrency ? Number(opts.condenseConcurrency) : 3,
    fabricPattern: opts.fabric as string | undefined,
    topN: opts.top ? Number(opts.top) : 30,
    jinaApiKey: process.env.JINA_API_KEY,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
    llmApiKey: process.env.DOCMIRROR_LLM_API_KEY || process.env.ANTHROPIC_API_KEY,
    llmBaseUrl: process.env.DOCMIRROR_LLM_BASE_URL,
  };

  // Surface degradation warnings upfront
  const warnings: string[] = [];
  if (!config.jinaApiKey) {
    const msg = "JINA_API_KEY not set — Jina Reader limited to 20 RPM (vs 500 with key)";
    log(`Warning: ${msg}`);
    warnings.push(msg);
  }
  if (config.condense && !config.llmApiKey && !Bun.which("claude")) {
    const msg = "--condense active but no LLM API key and no Claude CLI found — all pages will fall back to uncondensed";
    log(`Warning: ${msg}`);
    warnings.push(msg);
  }

  log(`Mirroring ${url} → ${outputDir}`);
  await mkdir(outputDir, { recursive: true });

  // Discovery
  log("Starting discovery...");
  const discovery = await discover(url, config);

  if (discovery.fullContent) {
    log("Got full content from /llms-full.txt — skipping per-page pipeline");
    await mkdir(join(outputDir, "pages"), { recursive: true });
    await mkdir(join(outputDir, "clean"), { recursive: true });
    await Bun.write(join(outputDir, "pages", "llms-full.md"), discovery.fullContent);
    await Bun.write(join(outputDir, "clean", "llms-full.md"), discovery.fullContent);

    const platform = detectPlatform([discovery.fullContent], url);
    const manifest = initManifest(config, discovery.method, platform, runStartedAt);
    addPageResult(manifest, {
      url: `${url}llms-full.txt`,
      status: "ok",
      fetchMethod: "llms-full-txt",
      rawPath: "pages/llms-full.md",
      cleanPath: "clean/llms-full.md",
      wordsBefore: discovery.fullContent.split(/\s+/).length,
      wordsAfter: discovery.fullContent.split(/\s+/).length,
    });

    const rawPages = new Map([["llms-full", discovery.fullContent]]);
    const cleanPages = new Map([["llms-full", discovery.fullContent]]);

    const validation = validate(rawPages, cleanPages, [url], manifest.pages, discovery.sitemapUrls, outputDir);
    // Fidelity is not applicable — single-file fast path, no stripping performed
    validation.fidelity = {
      totalPages: 1,
      overStripped: 0,
      pages: [{
        url: "llms-full",
        wordsBefore: discovery.fullContent.split(/\s+/).length,
        wordsAfter: discovery.fullContent.split(/\s+/).length,
        retentionPercent: 100,
        missingHeadings: [],
      }],
    };
    manifest.validation = validation;
    // The fast path recorded no tokenEstimate, so `run.json` was missing the one
    // figure anything sizing a context budget needs — while the compiled file's
    // own header printed it. Anything reading the manifest instead of the file
    // had to re-derive it, and a bytes/4 approximation disagrees with
    // estimateTokens by 40-65%.
    manifest.tokenEstimate = estimateTokens(discovery.fullContent);
    manifest.completedAt = new Date().toISOString();

    compile(cleanPages, manifest, outputDir);
    saveManifest(manifest, outputDir);

    log(`Done. Output: ${outputDir}/`);
    log(`Run details: bun ${process.argv[1]} inspect ${outputDir}`);
    console.log(JSON.stringify({
      outputDir,
      pages: 1,
      method: discovery.method,
      fidelity: "not applicable — single-file fast path, no stripping performed",
    }, null, 2));
    return;
  }

  if (discovery.urls.length === 0) {
    log("No URLs discovered. Nothing to mirror.");
    process.exit(1);
  }

  log(`Discovered ${discovery.urls.length} URLs via ${discovery.method}`);

  // Fetch pages
  const pageResults = await fetchPages(discovery.urls, config, outputDir);
  const successCount = pageResults.filter((p) => p.status === "ok").length;
  const exclusions = summarizeExclusions(pageResults);
  log(`Fetched ${successCount}/${discovery.urls.length} pages`);
  if (exclusions.count > 0) {
    log(`Excluded ${exclusions.count}/${discovery.urls.length} (dead links, redirects, or unfetchable — not a partial run): ${formatExclusionBreakdown(exclusions)}`);
  }

  // Load raw pages from disk
  const rawPages = new Map<string, string>();
  for (const result of pageResults) {
    if (result.status === "ok" && result.rawPath) {
      try {
        const content = await Bun.file(join(outputDir, result.rawPath)).text();
        const slug = result.rawPath.replace("pages/", "").replace(".md", "");
        rawPages.set(slug, content);
      } catch {
        // skip unreadable pages
      }
    }
  }

  // Detect platform — pass all pages, detectPlatform samples representatively
  const platform = detectPlatform(Array.from(rawPages.values()), url);
  log(`Platform: ${platform.platform} (confidence: ${platform.confidence.toFixed(2)})`);

  // Strip noise
  const cleanResults = stripPages(rawPages, platform, outputDir);
  const cleanPages = new Map<string, string>();
  const flagsBySlug = new Map<string, string[]>();
  for (const [slug, result] of cleanResults) {
    cleanPages.set(slug, result.content);
    flagsBySlug.set(slug, result.flags);
  }

  // Smart pruning — filter pages by relevance before further processing
  let pagesForCompile = cleanPages;
  let smartResult: import("./smart.ts").SmartPruneResult | undefined;
  if (config.smart) {
    smartResult = smartPrune(pagesForCompile, config.smart, config.topN);
    pagesForCompile = smartResult.pages;
  }

  // Condense — LLM compression with structural validation
  let condenseStats: { total: number; condensed: number; fallback: number; errors: number; avgReductionPct: number } | undefined;
  if (config.condense) {
    log("Starting condense...");
    const { condensed, stats } = await condensePages(pagesForCompile, {
      llm: { model: config.condenseModel, apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl },
      concurrency: config.condenseConcurrency,
    });
    pagesForCompile = condensed;
    condenseStats = stats;
    log(`Condense: ${stats.condensed}/${stats.total} pages condensed, ${stats.fallback} fallback, ${stats.errors} errors. Avg reduction: ${stats.avgReductionPct.toFixed(1)}%`);
    log("Note: condense validation is structural (code blocks, headings, word count). Semantic drift is possible.");
    if (stats.condensed === 0 && stats.total > 0) {
      const msg = stats.errors > 0
        ? `Condense failed on all ${stats.total} pages (${stats.errors} errors) — check LLM API key/provider configuration`
        : `Condense fell back on all ${stats.total} pages — model may not be following the prompt well enough, or pages are already minimal`;
      log(`Warning: ${msg}`);
      warnings.push(msg);
    }
  }

  // Validate — use pagesForCompile (the actual shipped artifact) for cleanliness, rawPages for fidelity baseline
  const validation = validate(rawPages, pagesForCompile, discovery.urls, pageResults, discovery.sitemapUrls, outputDir);

  // Build manifest — attach per-page flags
  const manifest = initManifest(config, discovery.method, platform, runStartedAt);
  for (const result of pageResults) {
    if (result.status === "ok" && result.rawPath) {
      const slug = result.rawPath.replace("pages/", "").replace(".md", "");
      result.flags = flagsBySlug.get(slug) ?? [];
    }
    addPageResult(manifest, result);
  }
  manifest.validation = validation;
  if (condenseStats) {
    manifest.condenseStats = condenseStats;
  }
  manifest.qualitySummary = computeQualitySummary(manifest);
  manifest.completedAt = new Date().toISOString();

  // Compile + postcompile (dedup, heading normalisation, grouped TOC)
  const rawCompiled = compile(pagesForCompile, manifest, outputDir);
  const { output: compiled, stats: postStats } = postcompile(rawCompiled, name, url);
  if (postStats.pagesDropped > 0 || postStats.blocksDeduped > 0) {
    log(`Postcompile: dropped ${postStats.pagesDropped} duplicate pages, removed ${postStats.blocksDeduped} duplicate blocks, normalised ${postStats.headingsNormalised} headings`);
  }
  const compiledPath = join(outputDir, `${slugify(name)}-docs-compiled.md`);
  await Bun.write(compiledPath, compiled);
  const tokenEstimate = estimateTokens(compiled);
  manifest.tokenEstimate = tokenEstimate;

  // Fabric — optional post-compile pipe
  if (config.fabricPattern) {
    const compiledPath = join(outputDir, `${slugify(name)}-docs-compiled.md`);
    const origPath = compiledPath + ".orig";
    await Bun.write(origPath, compiled);
    try {
      const which = Bun.spawnSync(["which", "fabric"]);
      if (which.exitCode === 0) {
        log(`Piping through fabric -p ${config.fabricPattern}...`);
        const fabricProc = Bun.spawn(["fabric", "-p", config.fabricPattern], {
          stdin: new Blob([compiled]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const fabricOutput = await new Response(fabricProc.stdout).text();
        await fabricProc.exited;
        if (fabricProc.exitCode === 0 && fabricOutput.trim()) {
          await Bun.write(compiledPath, fabricOutput);
          log(`Fabric pattern "${config.fabricPattern}" applied.`);
        } else {
          const origContent = await Bun.file(origPath).text();
          await Bun.write(compiledPath, origContent);
          log(`Warning: fabric exited with code ${fabricProc.exitCode}. Restored original compiled output.`);
        }
      } else {
        log("Warning: fabric CLI not found. Install fabric (https://github.com/danielmiessler/fabric) to use --fabric. Skipping.");
      }
    } catch (err) {
      try {
        const origContent = await Bun.file(origPath).text();
        await Bun.write(compiledPath, origContent);
      } catch { /* orig write failed too — nothing to restore */ }
      log(`Warning: fabric pipe failed: ${err instanceof Error ? err.message : String(err)}. Restored original.`);
    }
  }

  saveManifest(manifest, outputDir);

  const quality = manifest.qualitySummary!;
  log(`Done. ${successCount}/${discovery.urls.length} discovered URLs became pages (${exclusions.count} excluded, see above) → ~${tokenEstimate} tokens.`);
  log(`Quality: ${quality.clean}/${quality.total} clean (${quality.cleanPct}%) — this grades the ${successCount} pages that were fetched, not the ${discovery.urls.length} URLs discovered. Output: ${outputDir}/`);
  log(`Run details (per-page status, exclusion reasons, timing): bun ${process.argv[1]} inspect ${outputDir}`);
  console.log(
    JSON.stringify(
      {
        outputDir,
        pages: successCount,
        totalDiscovered: discovery.urls.length,
        method: discovery.method,
        partial: discovery.partial ?? false,
        platform: platform.platform,
        tokenEstimate,
        quality: {
          clean: quality.clean,
          total: quality.total,
          pct: quality.cleanPct,
          flags: Object.keys(quality.flagCounts).length > 0 ? quality.flagCounts : undefined,
        },
        excluded: exclusions.count > 0 ? {
          count: exclusions.count,
          reasons: exclusions.reasons,
          note: "these are URLs that were discovered but not fetched — not counted in `quality` above; see reports/coverage.json for the full per-URL list",
        } : undefined,
        cleanliness: `${validation.cleanliness.flaggedPercent.toFixed(1)}% flagged`,
        fidelity: `${validation.fidelity.overStripped} over-stripped`,
        coverage: `${validation.coverage.fetchPercent.toFixed(1)}% of discovered URLs fetched`,
        sitemapCoverage: validation.coverage.sitemapCoverage !== undefined
          ? `${validation.coverage.sitemapCoverage.toFixed(1)}% of sitemap URLs covered`
          : undefined,
        condense: condenseStats ? {
          condensed: condenseStats.condensed,
          fallback: condenseStats.fallback,
          errors: condenseStats.errors,
          avgReduction: `${condenseStats.avgReductionPct.toFixed(1)}%`,
          validation: "structural only (code blocks, headings, word count)",
        } : undefined,
        discovery: discovery.metadata.curated === "true" ? {
          curated: true,
          curatedCount: Number(discovery.metadata.curatedCount),
        } : undefined,
        smart: smartResult && smartResult.dropped > 0 ? {
          query: smartResult.query,
          kept: smartResult.kept,
          dropped: smartResult.dropped,
          note: "BM25 lexical matching — synonym-phrased pages may be missed",
        } : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
      null,
      2,
    ),
  );
}

async function resumeCommand(dir: string): Promise<void> {
  const manifest = loadManifest(dir);
  if (!manifest) {
    log(`No run.json found in ${dir}`);
    process.exit(1);
  }

  const { completed, pending } = getResumeState(manifest);
  log(`Resume: ${completed.length} completed, ${pending.length} pending`);

  if (pending.length === 0) {
    log("All pages already fetched. Nothing to resume.");
    return;
  }

  const config: RunConfig = {
    ...manifest.config,
    condenseModel: manifest.config.condenseModel ?? "haiku",
    condenseConcurrency: manifest.config.condenseConcurrency ?? 3,
    jinaApiKey: process.env.JINA_API_KEY,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
    llmApiKey: process.env.DOCMIRROR_LLM_API_KEY || process.env.ANTHROPIC_API_KEY,
    llmBaseUrl: process.env.DOCMIRROR_LLM_BASE_URL,
  };

  // Re-fetch pending pages
  const newPageResults = await fetchPages(pending, config, dir);

  // De-duplicate: remove existing entries for re-fetched URLs, then add new results
  const refetchedUrls = new Set(newPageResults.map((r) => r.url));
  manifest.pages = manifest.pages.filter((p) => !refetchedUrls.has(p.url));
  for (const result of newPageResults) {
    addPageResult(manifest, result);
  }

  // Load ALL raw pages from disk (previously-completed + newly-fetched)
  const pagesDir = join(dir, "pages");
  const rawPages = new Map<string, string>();
  try {
    const files = await readdir(pagesDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const slug = file.replace(/\.md$/, "");
      try {
        const content = await Bun.file(join(pagesDir, file)).text();
        rawPages.set(slug, content);
      } catch { /* skip unreadable */ }
    }
  } catch {
    log("Warning: could not read pages/ directory");
  }

  // Detect platform from sample pages
  const samplePages = Array.from(rawPages.values()).slice(0, 5);
  const platform = detectPlatform(samplePages, manifest.url);

  // Strip all raw pages
  const cleanResults = stripPages(rawPages, platform, dir);
  const cleanPages = new Map<string, string>();
  const flagsBySlug = new Map<string, string[]>();
  for (const [slug, result] of cleanResults) {
    cleanPages.set(slug, result.content);
    flagsBySlug.set(slug, result.flags);
  }

  // Attach per-page flags to manifest entries
  for (const page of manifest.pages) {
    if (page.status === "ok" && page.rawPath) {
      const slug = page.rawPath.replace("pages/", "").replace(".md", "");
      page.flags = flagsBySlug.get(slug) ?? [];
    }
  }

  // Validate
  const discoveredUrls = manifest.pages.map((p) => p.url);
  const validation = validate(rawPages, cleanPages, discoveredUrls, manifest.pages, undefined, dir);
  manifest.validation = validation;

  // Compile + postcompile
  const rawCompiled = compile(cleanPages, manifest, dir);
  const { output: compiled } = postcompile(rawCompiled, manifest.name, manifest.url);
  const compiledSlug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  await Bun.write(join(dir, `${compiledSlug}-docs-compiled.md`), compiled);
  const tokenEstimate = estimateTokens(compiled);
  manifest.tokenEstimate = tokenEstimate;

  // Quality summary
  manifest.qualitySummary = computeQualitySummary(manifest);
  manifest.platform = platform;
  manifest.completedAt = new Date().toISOString();
  saveManifest(manifest, dir);

  const total = manifest.pages.filter((p) => p.status === "ok").length;
  const quality = manifest.qualitySummary;
  const exclusions = summarizeExclusions(manifest.pages);
  log(`Resume complete. ${total}/${manifest.pages.length} tracked URLs are pages (${exclusions.count} excluded) → ~${tokenEstimate} tokens.`);
  if (exclusions.count > 0) {
    log(`Excluded: ${formatExclusionBreakdown(exclusions)}`);
  }
  log(`Quality: ${quality.clean}/${quality.total} clean (${quality.cleanPct}%) — this grades the ${total} pages that were fetched, not the ${manifest.pages.length} URLs tracked.`);
  log(`Run details (per-page status, exclusion reasons, timing): bun ${process.argv[1]} inspect ${dir}`);
  console.log(JSON.stringify({
    dir,
    resumedPages: newPageResults.length,
    totalPages: total,
    totalTracked: manifest.pages.length,
    excluded: exclusions.count > 0 ? { count: exclusions.count, reasons: exclusions.reasons } : undefined,
    tokenEstimate,
    quality: {
      clean: quality.clean,
      total: quality.total,
      pct: quality.cleanPct,
      flags: Object.keys(quality.flagCounts).length > 0 ? quality.flagCounts : undefined,
    },
  }, null, 2));
}

async function inspectCommand(dir: string): Promise<void> {
  const manifest = loadManifest(dir);
  if (!manifest) {
    log(`No run.json found in ${dir}`);
    process.exit(1);
  }

  const { pending } = getResumeState(manifest);
  const ok = manifest.pages.filter((p) => p.status === "ok").length;
  const errored = manifest.pages.filter((p) => p.status === "error").length;

  const flaggedPages = manifest.pages.filter((p) => p.flags && p.flags.length > 0);

  console.log(
    JSON.stringify(
      {
        url: manifest.url,
        name: manifest.name,
        startedAt: manifest.startedAt,
        completedAt: manifest.completedAt,
        discoveryMethod: manifest.discoveryMethod,
        platform: manifest.platform,
        pages: { total: manifest.pages.length, ok, errored, pending: pending.length },
        tokenEstimate: manifest.tokenEstimate,
        quality: manifest.qualitySummary ?? null,
        flaggedPages: flaggedPages.length > 0
          ? flaggedPages.map((p) => ({ url: p.url, flags: p.flags }))
          : undefined,
        validation: manifest.validation
          ? {
              cleanliness: `${manifest.validation.cleanliness.flaggedPercent.toFixed(1)}% flagged`,
              fidelity: `${manifest.validation.fidelity.overStripped} over-stripped`,
              coverage: `${manifest.validation.coverage.fetchPercent.toFixed(1)}% fetched`,
            }
          : null,
      },
      null,
      2,
    ),
  );
}

const program = new Command();

program
  .name("docmirror")
  .description("Turn a doc site URL into a clean markdown corpus optimized for LLM context windows")
  .version(VERSION);

program
  .argument("<url>", "Documentation site URL to mirror")
  .option("--name <name>", "Override display name (used in directory and filenames)")
  .option("--smart <query>", "Select top N pages by relevance to query")
  .option("--filter <query>", "Include only pages matching query")
  .option("--condense", "LLM-condense each page (requires Claude CLI or ANTHROPIC_API_KEY)")
  .option("--condense-model <model>", "Model for condensing (default: DOCMIRROR_LLM_MODEL or haiku)")
  .option("--condense-concurrency <n>", "Parallel condense workers", "3")
  .option("--fabric <pattern>", "Pipe compiled output through Fabric pattern")
  .option("--top <n>", "Number of pages for --smart", "30")
  .option("--lang <code>", "Language code for multi-language sites", "en")
  .option("--exclude-path <paths>", "Comma-separated path segments to exclude")
  .option("--force-map", "Force Firecrawl /map even if free methods work")
  .option("--max-pages <n>", "Hard cap on number of pages")
  .action(mirrorCommand);

program
  .command("resume <dir>")
  .description("Resume a failed or partial run")
  .action(resumeCommand);

program
  .command("inspect <dir>")
  .description("Show run state and per-page status")
  .action(inspectCommand);

program.parse();

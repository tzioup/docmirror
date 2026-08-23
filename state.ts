import type {
  RunManifest,
  RunConfig,
  PageResult,
  PlatformDetection,
  DiscoveryMethod,
  DiscoveryResult,
  DiscoverySnapshot,
  QualitySummary,
  ExclusionSummary,
} from "./types.ts";
import { join } from "node:path";
import { existsSync, renameSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

const MANIFEST_FILE = "run.json";
const MANIFEST_VERSION = "1.0.0";

export function initManifest(
  config: RunConfig,
  discoveryMethod: DiscoveryMethod,
  platform: PlatformDetection,
  // When the run actually began. The manifest is built near the END of a run —
  // it needs the page results and the platform detection, which do not exist
  // until the crawl is done — so stamping "now" here recorded the moment the
  // manifest was assembled, not the moment work started. `completedAt - startedAt`
  // then measured manifest assembly: a 2085-page astro crawl that really took
  // 12m14s reported 0.002s. Callers pass the timestamp they took on entry.
  startedAt?: string,
): RunManifest {
  const { jinaApiKey, firecrawlApiKey, llmApiKey, llmBaseUrl, ...safeConfig } = config;
  const name =
    config.name || new URL(config.url).hostname.replace(/^www\./, "");

  return {
    version: MANIFEST_VERSION,
    url: config.url,
    name,
    startedAt: startedAt ?? new Date().toISOString(),
    discoveryMethod,
    platform,
    pages: [],
    config: safeConfig,
  };
}

/**
 * Freeze what discovery saw into the manifest.
 *
 * `resume` rebuilds its world from `run.json` alone. Everything discovery
 * observed but did not fetch — the sitemap cross-reference above all — used to
 * exist only in memory during the mirror run, so a resumed run lost the one
 * genuinely independent coverage cross-check (issue #1). Persist it.
 */
export function captureDiscovery(discovery: DiscoveryResult): DiscoverySnapshot {
  const snapshot: DiscoverySnapshot = { partial: discovery.partial ?? false };
  if (discovery.sitemapUrls && discovery.sitemapUrls.length > 0) {
    snapshot.sitemapUrls = discovery.sitemapUrls;
  }
  if (discovery.unfollowedUrls && discovery.unfollowedUrls.length > 0) {
    snapshot.unfollowedUrls = discovery.unfollowedUrls;
  }
  return snapshot;
}

export function updateManifest(
  manifest: RunManifest,
  updates: Partial<RunManifest>,
): RunManifest {
  return Object.assign(manifest, updates);
}

export function addPageResult(
  manifest: RunManifest,
  result: PageResult,
): void {
  manifest.pages.push(result);
}

export function saveManifest(
  manifest: RunManifest,
  outputDir: string,
): void {
  mkdirSync(outputDir, { recursive: true });
  const target = join(outputDir, MANIFEST_FILE);
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, target);
}

export function loadManifest(outputDir: string): RunManifest | null {
  const target = join(outputDir, MANIFEST_FILE);
  if (!existsSync(target)) return null;

  try {
    const content = readFileSync(target, "utf-8");
    return JSON.parse(content) as RunManifest;
  } catch {
    return null;
  }
}

export function computeQualitySummary(manifest: RunManifest): QualitySummary {
  const okPages = manifest.pages.filter((p) => p.status === "ok");
  const total = okPages.length;
  const flagCounts: Record<string, number> = {};
  let clean = 0;

  for (const page of okPages) {
    if (!page.flags || page.flags.length === 0) {
      clean++;
    } else {
      for (const f of page.flags) {
        flagCounts[f] = (flagCounts[f] || 0) + 1;
      }
    }
  }

  return {
    total,
    clean,
    cleanPct: total > 0 ? Math.round((clean / total) * 1000) / 10 : 100,
    flagCounts,
  };
}

export function summarizeExclusions(pageResults: PageResult[]): ExclusionSummary {
  const reasons: Record<string, number> = {};
  let count = 0;

  for (const page of pageResults) {
    if (page.status === "ok") continue;
    count++;
    const reason = page.error ?? "Unknown error";
    reasons[reason] = (reasons[reason] || 0) + 1;
  }

  return { count, reasons };
}

export function formatExclusionBreakdown(summary: ExclusionSummary): string {
  return Object.entries(summary.reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
}

export function getResumeState(
  manifest: RunManifest,
): { completed: string[]; pending: string[] } {
  const completed: string[] = [];
  const pending: string[] = [];

  for (const page of manifest.pages) {
    if (page.status === "ok") {
      completed.push(page.url);
    } else {
      pending.push(page.url);
    }
  }

  return { completed, pending };
}

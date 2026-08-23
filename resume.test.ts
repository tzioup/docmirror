import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initManifest,
  addPageResult,
  saveManifest,
  loadManifest,
  captureDiscovery,
} from "./state.ts";
import { validateResumedRun } from "./validate.ts";
import type { RunConfig, DiscoveryResult, PlatformDetection } from "./types.ts";

/**
 * Defect (b) of issue #1: `resume` passed `sitemapUrls` as `undefined`, so
 * `coverage.sitemapCoverage` — the one genuinely independent cross-check,
 * because it compares discovered URLs against an external list rather than
 * against themselves — disappeared on precisely the runs that had already
 * failed once.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "docmirror-resume-test-"));
  dirs.push(d);
  return d;
}

const platform: PlatformDetection = {
  platform: "generic",
  confidence: 1,
  evidence: [],
};

function config(outputDir: string): RunConfig {
  return {
    url: "https://docs.test/",
    outputDir,
    lang: "en",
    excludePaths: [],
    forceMap: false,
    condense: false,
    condenseModel: "haiku",
    condenseConcurrency: 1,
    topN: 10,
  };
}

function urls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://docs.test/p${i + 1}`);
}

/** A mirror run that discovered 20 of a 100-URL sitemap, then wrote run.json. */
function writeInterruptedRun(dir: string): void {
  const sitemapUrls = urls(100);
  const discovery: DiscoveryResult = {
    urls: sitemapUrls.slice(0, 20),
    method: "link-crawl",
    sitemapUrls,
    metadata: {},
  };

  const manifest = initManifest(config(dir), discovery.method, platform);
  manifest.discovery = captureDiscovery(discovery);
  for (const url of discovery.urls) {
    addPageResult(manifest, { url, status: "ok" });
  }
  saveManifest(manifest, dir);
}

describe("resume — the sitemap cross-check must survive the round trip", () => {
  test("recovers sitemapCoverage from run.json instead of dropping it", () => {
    const dir = tempDir();
    writeInterruptedRun(dir);

    const manifest = loadManifest(dir);
    expect(manifest).not.toBeNull();

    const report = validateResumedRun(manifest!, new Map(), new Map());

    // Before the fix this was `undefined`: resume passed no sitemap at all.
    expect(report.coverage.sitemapCoverage).toBeDefined();
    expect(report.coverage.sitemapUrls).toBe(100);
    expect(report.coverage.sitemapCoverage).toBe(20);
  });

  test("keeps the widened fetch denominator across resume, so a partial mirror stays visibly partial", () => {
    const dir = tempDir();
    writeInterruptedRun(dir);

    const report = validateResumedRun(loadManifest(dir)!, new Map(), new Map());

    expect(report.coverage.observedUrls).toBe(100);
    expect(report.coverage.fetchPercent).toBe(20);
    expect(report.coverage.fetchOfDiscoveredPercent).toBe(100);
  });

  test("persists the discovery snapshot through JSON so nothing survives only in memory", () => {
    const dir = tempDir();
    const discovery: DiscoveryResult = {
      urls: urls(5),
      method: "link-crawl",
      sitemapUrls: urls(50),
      unfollowedUrls: urls(7),
      partial: true,
      metadata: {},
    };

    const manifest = initManifest(config(dir), discovery.method, platform);
    manifest.discovery = captureDiscovery(discovery);
    saveManifest(manifest, dir);

    const reloaded = loadManifest(dir);

    expect(reloaded!.discovery).toEqual({
      partial: true,
      sitemapUrls: urls(50),
      unfollowedUrls: urls(7),
    });
  });

  test("omits empty lists from the snapshot rather than persisting noise", () => {
    const snapshot = captureDiscovery({
      urls: [],
      method: "llms-full-txt",
      sitemapUrls: [],
      unfollowedUrls: [],
      metadata: {},
    });

    expect(snapshot).toEqual({ partial: false });
  });

  test("degrades to no cross-check, not a crash, on a run.json written before the snapshot existed", () => {
    const dir = tempDir();
    const manifest = initManifest(config(dir), "link-crawl", platform);
    for (const url of urls(3)) addPageResult(manifest, { url, status: "ok" });
    saveManifest(manifest, dir);

    const report = validateResumedRun(loadManifest(dir)!, new Map(), new Map());

    expect(report.coverage.sitemapCoverage).toBeUndefined();
    expect(report.coverage.fetchedPages).toBe(3);
  });
});

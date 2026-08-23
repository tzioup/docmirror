import { test, expect, describe } from "bun:test";
import { validateCoverage } from "./validate.ts";
import type { PageResult } from "./types.ts";

/**
 * Defect (a) of issue #1: `coverage.fetchPercent` divided by `discoveredUrls`,
 * so any loss during discovery shrank numerator and denominator together and a
 * mirror missing 440 of 500 pages still reported 100%.
 */

function ok(urls: string[]): PageResult[] {
  return urls.map((url) => ({ url, status: "ok" as const }));
}

function urls(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
}

describe("validateCoverage — fetchPercent must see discovery loss", () => {
  test("reports well under 100% when discovery kept 60 of the sitemap's 500 URLs and all 60 fetched", () => {
    const sitemapUrls = urls("https://docs.test/p", 500);
    const discoveredUrls = sitemapUrls.slice(0, 60);

    const coverage = validateCoverage(discoveredUrls, ok(discoveredUrls), {
      sitemapUrls,
    });

    // The exact number the old denominator produced for this input, and the
    // reason the issue was filed. If this ever passes again, the fix is gone.
    expect(coverage.fetchPercent).not.toBe(100);
    expect(coverage.observedUrls).toBe(500);
    expect(coverage.fetchedPages).toBe(60);
    expect(coverage.fetchPercent).toBe(12);
  });

  test("keeps the old fetch-stage ratio available as fetchOfDiscoveredPercent", () => {
    const sitemapUrls = urls("https://docs.test/p", 500);
    const discoveredUrls = sitemapUrls.slice(0, 60);

    const coverage = validateCoverage(discoveredUrls, ok(discoveredUrls), {
      sitemapUrls,
    });

    // "Did I fetch what I found?" is still a real question — it just is not the
    // one labelled as coverage.
    expect(coverage.fetchOfDiscoveredPercent).toBe(100);
    expect(coverage.discoveredUrls).toBe(60);
  });

  test("stays at 100% when discovery lost nothing, so the number is not merely always low", () => {
    const all = urls("https://docs.test/p", 40);

    const coverage = validateCoverage(all, ok(all), { sitemapUrls: all });

    expect(coverage.fetchPercent).toBe(100);
    expect(coverage.observedUrls).toBe(40);
  });

  test("counts URLs a rung retained but never followed as observed", () => {
    const discoveredUrls = urls("https://docs.test/p", 10);
    const unfollowedUrls = urls("https://docs.test/other", 5);

    const coverage = validateCoverage(discoveredUrls, ok(discoveredUrls), {
      unfollowedUrls,
    });

    expect(coverage.observedUrls).toBe(15);
    expect(coverage.unfollowedUrls).toBe(5);
    expect(coverage.fetchPercent).toBeLessThan(100);
  });

  test("does not double-count a URL that is both discovered and in the sitemap", () => {
    const all = urls("https://docs.test/p", 30);

    const coverage = validateCoverage(all, ok(all), {
      sitemapUrls: all,
      unfollowedUrls: all.slice(0, 5),
    });

    expect(coverage.observedUrls).toBe(30);
  });

  test("does not turn a complete llms-full.txt run into a false alarm via the sitemap cross-reference", () => {
    // The fast path fetches one artifact holding the whole corpus. Unioning a
    // 500-entry sitemap into the denominator would report ~0.2% for a run that
    // captured everything — trading a false 100% for a false failure.
    const sitemapUrls = urls("https://docs.test/p", 500);

    const coverage = validateCoverage(
      ["https://docs.test/"],
      ok(["https://docs.test/"]),
      { sitemapUrls, fullContent: true },
    );

    expect(coverage.observedUrls).toBe(1);
    expect(coverage.fetchPercent).toBe(100);
  });

  test("reports 0 rather than dividing by zero when discovery found nothing at all", () => {
    const coverage = validateCoverage([], [], {});

    expect(coverage.observedUrls).toBe(0);
    expect(coverage.fetchPercent).toBe(0);
    expect(coverage.fetchOfDiscoveredPercent).toBe(0);
  });

  test("still computes sitemapCoverage as the independent cross-check", () => {
    const sitemapUrls = urls("https://docs.test/p", 100);
    const discoveredUrls = sitemapUrls.slice(0, 25);

    const coverage = validateCoverage(discoveredUrls, ok(discoveredUrls), {
      sitemapUrls,
    });

    expect(coverage.sitemapUrls).toBe(100);
    expect(coverage.sitemapCoverage).toBe(25);
  });
});

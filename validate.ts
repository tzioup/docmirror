import type {
  CleanlinessReport,
  FidelityReport,
  CoverageReport,
  ValidationReport,
  PageResult,
  RunManifest,
} from "./types.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NOISE_FINGERPRINTS = [
  "Cookie",
  "Accept all",
  "Was this page helpful",
  "Previous / Next",
  "On this page",
  "Table of Contents",
  "[Edit on GitHub]",
  "[Suggest edits]",
  "Powered by",
  "Built with",
];

const BREADCRUMB_RE = /(?:.+ > ){2,}.+/;
const FLAG_THRESHOLD = 3;

function countConsecutiveLinkOnlyLines(content: string): number {
  const lines = content.split("\n");
  let maxRun = 0;
  let currentRun = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && /^\[.*\]\(.*\)$/.test(trimmed)) {
      currentRun++;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 0;
    }
  }

  return maxRun;
}

export function validateCleanliness(
  cleanPages: Map<string, string>,
): CleanlinessReport {
  const pages: CleanlinessReport["pages"] = [];

  for (const [url, content] of cleanPages) {
    const fingerprints: string[] = [];

    for (const fp of NOISE_FINGERPRINTS) {
      if (content.includes(fp)) {
        fingerprints.push(fp);
      }
    }

    if (BREADCRUMB_RE.test(content)) {
      fingerprints.push("breadcrumb sequence");
    }

    if (countConsecutiveLinkOnlyLines(content) > 5) {
      fingerprints.push("consecutive link-only lines");
    }

    if (fingerprints.length > 0) {
      pages.push({ url, noiseHits: fingerprints.length, fingerprints });
    }
  }

  const flaggedPages = pages.filter((p) => p.noiseHits > FLAG_THRESHOLD).length;

  return {
    totalPages: cleanPages.size,
    flaggedPages,
    flaggedPercent:
      cleanPages.size > 0
        ? Math.round((flaggedPages / cleanPages.size) * 10000) / 100
        : 0,
    pages,
  };
}

function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^(#{2,3})\s+(.+)/);
    if (match) {
      headings.push(match[2].trim());
    }
  }
  return headings;
}

function wordCount(content: string): number {
  return content.split(/\s+/).filter((w) => w.length > 0).length;
}

export function validateFidelity(
  rawPages: Map<string, string>,
  cleanPages: Map<string, string>,
): FidelityReport {
  const pages: FidelityReport["pages"] = [];

  for (const [url, rawContent] of rawPages) {
    const cleanContent = cleanPages.get(url);
    if (!cleanContent) continue;

    const rawHeadings = extractHeadings(rawContent);
    const cleanHeadings = extractHeadings(cleanContent);
    const cleanHeadingSet = new Set(cleanHeadings);
    const missingHeadings = rawHeadings.filter((h) => !cleanHeadingSet.has(h));

    const wb = wordCount(rawContent);
    const wa = wordCount(cleanContent);
    const retentionPercent = wb > 0 ? Math.round((wa / wb) * 10000) / 100 : 100;

    pages.push({
      url,
      wordsBefore: wb,
      wordsAfter: wa,
      retentionPercent,
      missingHeadings,
    });
  }

  const overStripped = pages.filter((p) => p.retentionPercent < 30).length;

  return {
    totalPages: pages.length,
    overStripped,
    pages,
  };
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 100 : 0;
}

/**
 * What discovery saw, beyond what survived into `discoveredUrls`.
 *
 * Passed as an object rather than a positional tail: the fast path needs to opt
 * out of the union denominator entirely, and a fifth positional boolean next to
 * two optional string arrays is a footgun.
 */
export interface CoverageInputs {
  /** URLs an external sitemap listed, whether or not discovery kept them. */
  sitemapUrls?: string[];
  /** URLs a rung retained but never followed for their own links (frontier cap). */
  unfollowedUrls?: string[];
  /**
   * The whole corpus arrived as a single artifact (`/llms-full.txt`), so URL
   * counts are not the coverage denominator. Without this, a fast-path run that
   * correctly captured everything in one file would union in a 500-entry sitemap
   * cross-reference and report ~0.2% — trading the old false 100% for a false
   * alarm on the tool's best path.
   */
  fullContent?: boolean;
}

/**
 * Coverage against the widest denominator any discovery rung observed.
 *
 * `fetchPercent` used to divide by `discoveredUrls.length`, so any loss during
 * discovery shrank numerator and denominator together and a mirror missing
 * 440 of 500 pages still reported 100% (issue #1). The denominator is now the
 * union of what every rung saw — discovered, sitemap entries, and links that
 * were retained but never followed — so discovery loss lowers the number.
 * The old fetch-stage ratio survives as `fetchOfDiscoveredPercent`.
 *
 * Note on the frontier cap specifically: unfollowed URLs are *retained* in the
 * crawl output, so they are already inside `discoveredUrls` and the union does
 * not move for them. What the cap actually loses is their subtrees, whose size
 * is unknowable. The honest signal there is `discovery.partial` plus the
 * `unfollowedUrls` count, not a bigger denominator.
 */
export function validateCoverage(
  discoveredUrls: string[],
  pageResults: PageResult[],
  inputs: CoverageInputs = {},
): CoverageReport {
  const { sitemapUrls, unfollowedUrls, fullContent } = inputs;

  const fetchedSet = new Set(
    pageResults.filter((p) => p.status === "ok").map((p) => p.url),
  );
  const fetchedPages = fetchedSet.size;

  const observed = new Set(discoveredUrls);
  if (!fullContent) {
    for (const u of sitemapUrls ?? []) observed.add(u);
    for (const u of unfollowedUrls ?? []) observed.add(u);
  }
  const observedUrls = observed.size;

  const fetchPercent = pct(fetchedPages, observedUrls);
  const fetchOfDiscoveredPercent = pct(fetchedPages, discoveredUrls.length);

  const resultByUrl = new Map(pageResults.map((p) => [p.url, p]));
  const gaps = discoveredUrls
    .filter((u) => !fetchedSet.has(u))
    .map((u) => ({ url: u, reason: resultByUrl.get(u)?.error ?? "not attempted" }));

  const report: CoverageReport = {
    discoveredUrls: discoveredUrls.length,
    observedUrls,
    fetchedPages,
    fetchPercent,
    fetchOfDiscoveredPercent,
    gaps,
  };

  if (unfollowedUrls && unfollowedUrls.length > 0) {
    report.unfollowedUrls = unfollowedUrls.length;
  }

  if (sitemapUrls) {
    const discoveredSet = new Set(discoveredUrls);
    const sitemapMissing = sitemapUrls.filter((u) => !discoveredSet.has(u));
    report.sitemapUrls = sitemapUrls.length;
    report.sitemapCoverage =
      sitemapUrls.length > 0
        ? Math.round(
            ((sitemapUrls.length - sitemapMissing.length) / sitemapUrls.length) *
              10000,
          ) / 100
        : 100;
    report.gaps = [
      ...gaps,
      ...sitemapMissing.map((u) => ({ url: u, reason: "in sitemap but excluded before fetch (maxPages, filter, or exclude-path)" })),
    ];
  }

  return report;
}

export interface ValidateOptions extends CoverageInputs {
  outputDir?: string;
}

export function validate(
  rawPages: Map<string, string>,
  cleanPages: Map<string, string>,
  discoveredUrls: string[],
  pageResults: PageResult[],
  options: ValidateOptions = {},
): ValidationReport {
  const { outputDir, ...coverageInputs } = options;
  const cleanliness = validateCleanliness(cleanPages);
  const fidelity = validateFidelity(rawPages, cleanPages);
  const coverage = validateCoverage(discoveredUrls, pageResults, coverageInputs);

  if (outputDir) {
    const reportsDir = join(outputDir, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, "cleanliness.json"),
      JSON.stringify(cleanliness, null, 2),
    );
    writeFileSync(
      join(reportsDir, "fidelity.json"),
      JSON.stringify(fidelity, null, 2),
    );
    writeFileSync(
      join(reportsDir, "coverage.json"),
      JSON.stringify(coverage, null, 2),
    );
  }

  return { cleanliness, fidelity, coverage };
}

/**
 * Validation for a resumed run.
 *
 * `resume` used to call `validate(..., undefined, dir)` — passing no sitemap at
 * all — so `coverage.sitemapCoverage` vanished on exactly the runs that had
 * already failed once and most needed the independent cross-check (issue #1).
 * The sitemap list is now persisted on the manifest at mirror time, and this
 * reads it back, so the cross-check survives the round trip.
 */
export function validateResumedRun(
  manifest: RunManifest,
  rawPages: Map<string, string>,
  cleanPages: Map<string, string>,
  outputDir?: string,
): ValidationReport {
  const discoveredUrls = manifest.pages.map((p) => p.url);
  return validate(rawPages, cleanPages, discoveredUrls, manifest.pages, {
    sitemapUrls: manifest.discovery?.sitemapUrls,
    unfollowedUrls: manifest.discovery?.unfollowedUrls,
    outputDir,
  });
}

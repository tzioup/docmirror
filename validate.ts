import type {
  CleanlinessReport,
  FidelityReport,
  CoverageReport,
  ValidationReport,
  PageResult,
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

export function validateCoverage(
  discoveredUrls: string[],
  pageResults: PageResult[],
  sitemapUrls?: string[],
): CoverageReport {
  const fetchedSet = new Set(
    pageResults.filter((p) => p.status === "ok").map((p) => p.url),
  );
  const fetchedPages = fetchedSet.size;
  const fetchPercent =
    discoveredUrls.length > 0
      ? Math.round((fetchedPages / discoveredUrls.length) * 10000) / 100
      : 0;

  const gaps = discoveredUrls.filter((u) => !fetchedSet.has(u));

  const report: CoverageReport = {
    discoveredUrls: discoveredUrls.length,
    fetchedPages,
    fetchPercent,
    gaps,
  };

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
    report.gaps = [...gaps, ...sitemapMissing.map((u) => `[sitemap] ${u}`)];
  }

  return report;
}

export function validate(
  rawPages: Map<string, string>,
  cleanPages: Map<string, string>,
  discoveredUrls: string[],
  pageResults: PageResult[],
  sitemapUrls?: string[],
  outputDir?: string,
): ValidationReport {
  const cleanliness = validateCleanliness(cleanPages);
  const fidelity = validateFidelity(rawPages, cleanPages);
  const coverage = validateCoverage(discoveredUrls, pageResults, sitemapUrls);

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

export interface RunConfig {
  url: string;
  name?: string;
  outputDir: string;
  lang: string;
  excludePaths: string[];
  forceMap: boolean;
  maxPages?: number;
  smart?: string;
  filter?: string;
  condense: boolean;
  condenseModel: string;
  condenseConcurrency: number;
  fabricPattern?: string;
  topN: number;
  jinaApiKey?: string;
  firecrawlApiKey?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
}

export interface DiscoveryResult {
  urls: string[];
  method: DiscoveryMethod;
  fullContent?: string;
  sitemapUrls?: string[];
  partial?: boolean;
  metadata: Record<string, string>;
}

export type DiscoveryMethod =
  | "llms-full-txt"
  | "llms-txt"
  | "content-negotiation"
  | "md-suffix"
  | "rtd-sources"
  | "sitemap"
  | "link-crawl"
  | "firecrawl-map";

export interface PageResult {
  url: string;
  status: "ok" | "error" | "skipped";
  fetchMethod?: FetchMethod;
  rawPath?: string;
  cleanPath?: string;
  error?: string;
  wordsBefore?: number;
  wordsAfter?: number;
  platform?: string;
  fetchDurationMs?: number;
  flags?: string[];
}

export type FetchMethod =
  | "llms-full-txt"
  | "content-negotiation"
  | "md-suffix"
  | "rtd-sources"
  | "local-html"
  | "jina";

export interface PlatformDetection {
  platform: string;
  confidence: number;
  evidence: string[];
}

export interface CleanResult {
  content: string;
  removed: string[];
  qualityGateFailed: boolean;
}

export interface ValidationReport {
  cleanliness: CleanlinessReport;
  fidelity: FidelityReport;
  coverage: CoverageReport;
}

export interface CleanlinessReport {
  totalPages: number;
  flaggedPages: number;
  flaggedPercent: number;
  pages: Array<{
    url: string;
    noiseHits: number;
    fingerprints: string[];
  }>;
}

export interface FidelityReport {
  totalPages: number;
  overStripped: number;
  pages: Array<{
    url: string;
    wordsBefore: number;
    wordsAfter: number;
    retentionPercent: number;
    missingHeadings: string[];
  }>;
}

export interface CoverageReport {
  discoveredUrls: number;
  fetchedPages: number;
  fetchPercent: number;
  sitemapUrls?: number;
  sitemapCoverage?: number;
  gaps: string[];
}

export interface RunManifest {
  version: string;
  url: string;
  name: string;
  startedAt: string;
  completedAt?: string;
  discoveryMethod: DiscoveryMethod;
  platform: PlatformDetection;
  pages: PageResult[];
  validation?: ValidationReport;
  condenseStats?: { total: number; condensed: number; fallback: number; errors: number; avgReductionPct: number };
  tokenEstimate?: number;
  qualitySummary?: QualitySummary;
  config: Omit<RunConfig, "jinaApiKey" | "firecrawlApiKey" | "llmApiKey" | "llmBaseUrl">;
}

export interface QualitySummary {
  total: number;
  clean: number;
  cleanPct: number;
  flagCounts: Record<string, number>;
}

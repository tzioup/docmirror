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
  /** True whenever any rung declined to explore something it saw — not only on cascade fall-through. */
  partial?: boolean;
  /** Links a rung retained but never followed for their own links (e.g. the link-crawl frontier cap). Their subtrees are undiscovered. */
  unfollowedUrls?: string[];
  metadata: Record<string, string>;
}

/** What discovery saw and declined, persisted in run.json so `resume` keeps the same denominator. */
export interface DiscoverySnapshot {
  partial: boolean;
  sitemapUrls?: string[];
  unfollowedUrls?: string[];
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
  /** Widest denominator any discovery rung observed: discovered ∪ sitemap ∪ unfollowed. */
  observedUrls: number;
  fetchedPages: number;
  /** fetchedPages / observedUrls — drops when discovery lost pages, unlike fetchOfDiscoveredPercent. */
  fetchPercent: number;
  /** fetchedPages / discoveredUrls — the fetch-stage number only ("did I fetch what I found?"). */
  fetchOfDiscoveredPercent: number;
  sitemapUrls?: number;
  sitemapCoverage?: number;
  /** Links seen but never followed for their own links; their subtrees are absent from the mirror. */
  unfollowedUrls?: number;
  gaps: Array<{ url: string; reason: string }>;
}

export interface RunManifest {
  version: string;
  url: string;
  name: string;
  startedAt: string;
  completedAt?: string;
  discoveryMethod: DiscoveryMethod;
  discovery?: DiscoverySnapshot;
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

export interface ExclusionSummary {
  count: number;
  reasons: Record<string, number>;
}

import type { RunConfig, DiscoveryResult, DiscoveryMethod } from "./types.ts";

const DISCOVERY_TIMEOUT = 5000;

const NON_EN_LANG_SEGMENTS = [
  "fr", "de", "ja", "zh", "ko", "es", "pt", "it", "ru", "nl", "pl", "sv",
  "tr", "ar", "th", "vi", "cs", "ro", "hu", "uk", "el", "he", "id", "ms",
  "da", "fi", "no", "sk", "bg", "hr", "sr", "sl", "lt", "lv", "et",
];

function log(msg: string): void {
  process.stderr.write(`[discover] ${msg}\n`);
}

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT) });
}

function filterUrls(urls: string[], baseUrl: string, config: RunConfig): string[] {
  const base = new URL(baseUrl);
  const domain = base.hostname;

  let filtered = urls
    .map((u) => {
      try {
        const parsed = new URL(u, baseUrl);
        parsed.hash = "";
        return parsed.href;
      } catch {
        return null;
      }
    })
    .filter((u): u is string => u !== null)
    .filter((u) => {
      try {
        return new URL(u).hostname === domain;
      } catch {
        return false;
      }
    });

  const lang = config.lang || "en";
  const excludeLangs = NON_EN_LANG_SEGMENTS.filter((l) => l !== lang);
  if (excludeLangs.length > 0) {
    filtered = filtered.filter((u) => {
      const pathSegments = new URL(u).pathname.split("/").filter(Boolean);
      return !pathSegments.some((seg) => excludeLangs.includes(seg.toLowerCase()));
    });
  }

  if (config.excludePaths.length > 0) {
    filtered = filtered.filter((u) => {
      const pathSegments = new URL(u).pathname.split("/").filter(Boolean);
      return !config.excludePaths.some((exclude) => pathSegments.includes(exclude));
    });
  }

  filtered = Array.from(new Set(filtered));

  if (config.maxPages) {
    filtered = filtered.slice(0, config.maxPages);
  }

  return filtered;
}

/**
 * Is this "full content" actually just an index of links?
 *
 * Some sites publish an llms.txt-shaped link list AT the llms-full.txt path.
 * Measured case: elevenlabs.io/docs/llms-full.txt is 189 KB of
 * `- [Title](url): description` lines — 13,433 words, so it sails past a
 * word-count gate, but contains no documentation at all. Accepting it produced
 * a corpus with 9 headings and zero code blocks that looked like a successful
 * run. That is the worst failure shape available here: silent, and committed.
 *
 * The discriminator is line shape, not size. Real full content is prose and
 * code in paragraphs; an index is one link per line.
 */
function looksLikeLinkIndex(text: string): { isIndex: boolean; ratio: number } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { isIndex: false, ratio: 0 };
  const linkLines = lines.filter((l) => /^[-*]\s*\[[^\]]*\]\([^)]*\)/.test(l)).length;
  const ratio = linkLines / lines.length;
  return { isIndex: ratio > 0.5, ratio };
}

async function probeLlmsFull(url: string): Promise<string | null> {
  try {
    const res = await timedFetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length <= 500 || !looksLikeMarkdown(text)) return null;

    // Require substantive content — reject stub landing pages
    const h2PlusCount = (text.match(/^#{2,6}\s/gm) || []).length;
    const wordCount = text.split(/\s+/).length;
    if (h2PlusCount < 3 || wordCount < 1000) {
      log(`${url} too thin (${h2PlusCount} headings, ${wordCount} words) — skipping`);
      return null;
    }

    const { isIndex, ratio } = looksLikeLinkIndex(text);
    if (isIndex) {
      log(`${url} is a link index (${(ratio * 100).toFixed(0)}% link lines), not full content — skipping`);
      return null;
    }

    log(`Found ${url} (${text.length} chars, ${h2PlusCount} headings, ${wordCount} words)`);
    return text;
  } catch {
    return null;
  }
}

async function tryLlmsFullTxt(baseUrl: string): Promise<{ fullContent: string } | null> {
  log("Trying /llms-full.txt...");

  // Probe BOTH the given path and the origin root. Neither alone is right:
  // measured, bun.sh publishes at /docs/llms-full.txt (and nothing at the
  // root), while hono.dev and vitest.dev publish at the root and 404 under
  // their docs path. Probing only path-relative made vitest link-crawl 195
  // pages over 213 seconds instead of taking one free GET.
  const trimmed = baseUrl.replace(/\/$/, "");
  const candidates = [`${trimmed}/llms-full.txt`];
  try {
    const originCandidate = `${new URL(baseUrl).origin}/llms-full.txt`;
    if (!candidates.includes(originCandidate)) candidates.push(originCandidate);
  } catch {
    // Unparseable base URL — the path-relative candidate is all we have.
  }

  for (const candidate of candidates) {
    const found = await probeLlmsFull(candidate);
    if (found) return { fullContent: found };
  }
  return null;
}

function looksLikeMarkdown(text: string): boolean {
  const indicators = [/^#{1,6}\s/m, /\[.*?\]\(.*?\)/, /^[-*]\s/m, /```/, /^\|.*\|/m];
  const matches = indicators.filter((r) => r.test(text)).length;
  return matches >= 2;
}

async function tryLlmsTxt(baseUrl: string, config: RunConfig): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/llms.txt`;
  log("Trying /llms.txt...");
  try {
    const res = await timedFetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    const urls: string[] = [];

    for (const line of text.split("\n")) {
      const linkMatch = line.match(/^-\s*\[.*?\]\((.*?)\)/);
      if (linkMatch) {
        urls.push(linkMatch[1]);
        continue;
      }
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (urlMatch) {
        urls.push(urlMatch[0]);
      }
    }

    const filtered = filterUrls(urls, baseUrl, config);
    log(`Found ${filtered.length} URLs from llms.txt`);
    return filtered;
  } catch {
    return [];
  }
}

async function trySitemap(baseUrl: string, config: RunConfig): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, "");
  const candidates = [`${base}/sitemap.xml`, `${base}/sitemap_index.xml`];
  log("Trying sitemap.xml...");

  for (const sitemapUrl of candidates) {
    try {
      const res = await timedFetch(sitemapUrl);
      if (!res.ok) continue;
      const xml = await res.text();
      const urls = await parseSitemapXml(xml, base, config);
      if (urls.length > 0) {
        const filtered = filterUrls(urls, baseUrl, config);
        log(`Found ${filtered.length} URLs via sitemap`);
        return filtered;
      }
    } catch {
      continue;
    }
  }

  return [];
}

async function parseSitemapXml(
  xml: string,
  _base: string,
  _config: RunConfig,
): Promise<string[]> {
  const urls: string[] = [];

  // Check if this is a sitemap index
  if (xml.includes("<sitemapindex")) {
    const childLocs = Array.from(xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)).map((m) => m[1]);
    for (const childUrl of childLocs) {
      try {
        const res = await timedFetch(childUrl);
        if (!res.ok) continue;
        const childXml = await res.text();
        const childUrls = Array.from(childXml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)).map((m) => m[1]);
        urls.push(...childUrls);
      } catch {
        continue;
      }
    }
  } else {
    const locs = Array.from(xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)).map((m) => m[1]);
    urls.push(...locs);
  }

  return urls;
}

async function tryLinkCrawl(baseUrl: string, config: RunConfig): Promise<string[]> {
  log("Trying link crawl from root...");
  try {
    const res = await timedFetch(baseUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const rootLinks = extractLinks(html, baseUrl);
    const filtered = filterUrls(rootLinks, baseUrl, config);

    // Follow one level deep
    const deepLinks: string[] = [...filtered];
    const toFollow = filtered.slice(0, 50); // Cap depth-1 crawl to avoid runaway
    const results = await Promise.allSettled(
      toFollow.map(async (link) => {
        try {
          const r = await timedFetch(link);
          if (!r.ok) return [];
          const h = await r.text();
          return extractLinks(h, baseUrl);
        } catch {
          return [];
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        deepLinks.push(...result.value);
      }
    }

    const allFiltered = filterUrls(deepLinks, baseUrl, config);
    log(`Found ${allFiltered.length} URLs via link crawl`);
    return allFiltered;
  } catch {
    return [];
  }
}

function extractLinks(html: string, baseUrl: string): string[] {
  const hrefs = Array.from(html.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)).map((m) => m[1]);
  return hrefs
    .filter((h) => !h.startsWith("#") && !h.startsWith("mailto:") && !h.startsWith("javascript:"))
    .map((h) => {
      try {
        return new URL(h, baseUrl).href;
      } catch {
        return null;
      }
    })
    .filter((u): u is string => u !== null);
}

async function tryFirecrawlMap(baseUrl: string, config: RunConfig): Promise<string[]> {
  if (!config.firecrawlApiKey) return [];
  log("Trying Firecrawl /map...");
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/map", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.firecrawlApiKey}`,
      },
      body: JSON.stringify({ url: baseUrl }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log(`Firecrawl /map returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { success?: boolean; links?: string[] };
    if (!data.success || !data.links) return [];
    const filtered = filterUrls(data.links, baseUrl, config);
    log(`Found ${filtered.length} URLs via Firecrawl /map`);
    return filtered;
  } catch {
    return [];
  }
}

async function tryFirecrawlSearch(
  baseUrl: string,
  query: string,
  config: RunConfig,
): Promise<string[]> {
  if (!config.firecrawlApiKey) return [];
  try {
    const res = await timedFetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.firecrawlApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit: config.maxPages ?? 50,
        scrapeOptions: { formats: ["markdown"] },
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { success?: boolean; data?: Array<{ url?: string }> };
    if (!data.success || !data.data) return [];
    const urls = data.data.map((d) => d.url).filter(Boolean) as string[];
    const filtered = filterUrls(urls, baseUrl, config);
    log(`Found ${filtered.length} URLs via Firecrawl search for "${query}"`);
    return filtered;
  } catch {
    return [];
  }
}

const SUFFICIENCY_THRESHOLD = 5;

export async function discover(baseUrl: string, config: RunConfig): Promise<DiscoveryResult> {
  // --filter: use Firecrawl search as alternative discovery
  if (config.filter) {
    if (!config.firecrawlApiKey) {
      log("Warning: --filter requires FIRECRAWL_API_KEY. Ignoring filter, using normal discovery.");
    } else {
      const searchUrls = await tryFirecrawlSearch(baseUrl, config.filter, config);
      if (searchUrls.length > 0) {
        return {
          urls: searchUrls,
          method: "firecrawl-map",
          metadata: { method: "firecrawl-search", query: config.filter },
        };
      }
      log("Firecrawl search returned no results. Falling back to normal discovery.");
    }
  }

  let stagesAttempted = 0;

  // Stage 1: /llms-full.txt
  stagesAttempted++;
  const fullTxt = await tryLlmsFullTxt(baseUrl);
  if (fullTxt) {
    // Cross-reference: probe sitemap even though stage 1 won
    let sitemapCrossRef: string[] | undefined;
    try {
      const probed = await trySitemap(baseUrl, config);
      if (probed.length > 0) sitemapCrossRef = probed;
    } catch { /* fail-open */ }

    return {
      urls: [],
      method: "llms-full-txt",
      fullContent: fullTxt.fullContent,
      sitemapUrls: sitemapCrossRef,
      metadata: { stagesAttempted: String(stagesAttempted), method: "llms-full-txt" },
    };
  }

  // Stage 2: /llms.txt
  stagesAttempted++;
  const llmsUrls = await tryLlmsTxt(baseUrl, config);
  if (llmsUrls.length >= SUFFICIENCY_THRESHOLD) {
    // Cross-reference: probe sitemap even though stage 2 won
    let sitemapCrossRef: string[] | undefined;
    try {
      const probed = await trySitemap(baseUrl, config);
      if (probed.length > 0) sitemapCrossRef = probed;
    } catch { /* fail-open */ }

    return {
      urls: llmsUrls,
      method: "llms-txt",
      sitemapUrls: sitemapCrossRef,
      metadata: { stagesAttempted: String(stagesAttempted), method: "llms-txt", curated: "true", curatedCount: String(llmsUrls.length) },
    };
  }

  // Stage 3: sitemap.xml
  stagesAttempted++;
  const sitemapUrls = await trySitemap(baseUrl, config);
  if (sitemapUrls.length >= SUFFICIENCY_THRESHOLD) {
    // Sitemap was the winning stage — pass its URLs as sitemapUrls too
    return {
      urls: sitemapUrls,
      method: "sitemap",
      sitemapUrls: sitemapUrls,
      metadata: { stagesAttempted: String(stagesAttempted), method: "sitemap" },
    };
  }

  // Stage 4: link crawl
  stagesAttempted++;
  const crawlUrls = await tryLinkCrawl(baseUrl, config);
  if (crawlUrls.length >= SUFFICIENCY_THRESHOLD) {
    // Cross-reference: sitemap was already probed at stage 3, reuse if non-empty
    return {
      urls: crawlUrls,
      method: "link-crawl",
      sitemapUrls: sitemapUrls.length > 0 ? sitemapUrls : undefined,
      metadata: { stagesAttempted: String(stagesAttempted), method: "link-crawl" },
    };
  }

  // Stage 5: Firecrawl /map — only if explicitly forced or all free methods fell short
  if (config.firecrawlApiKey) {
    stagesAttempted++;
    const firecrawlUrls = await tryFirecrawlMap(baseUrl, config);
    if (firecrawlUrls.length > 0) {
      return {
        urls: firecrawlUrls,
        method: "firecrawl-map",
        sitemapUrls: sitemapUrls.length > 0 ? sitemapUrls : undefined,
        metadata: { stagesAttempted: String(stagesAttempted), method: "firecrawl-map" },
      };
    }
  }

  // Fall through: return best partial result from earlier stages
  const bestUrls = crawlUrls.length > 0
    ? crawlUrls
    : sitemapUrls.length > 0
      ? sitemapUrls
      : llmsUrls;

  const bestMethod: DiscoveryMethod = crawlUrls.length > 0
    ? "link-crawl"
    : sitemapUrls.length > 0
      ? "sitemap"
      : "llms-txt";

  log(`All stages exhausted. Best result: ${bestUrls.length} URLs via ${bestMethod}`);

  return {
    urls: bestUrls,
    method: bestMethod,
    partial: true,
    sitemapUrls: sitemapUrls.length > 0 ? sitemapUrls : undefined,
    metadata: { stagesAttempted: String(stagesAttempted), method: bestMethod, partial: "true" },
  };
}

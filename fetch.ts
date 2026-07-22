import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { PageResult, FetchMethod, RunConfig } from "./types.ts";

interface FetchedPage extends PageResult {
  content?: string;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(rpm: number) {
    this.maxTokens = rpm;
    this.tokens = rpm;
    this.refillRate = rpm / 60_000;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

export interface LocalHtmlExtraction {
  contentHtml: string;
  source: string;
  text: string;
}

const localHtmlUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
const localHtmlAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const localHtmlSelectorCandidates = [
  { selector: "article", source: "article" },
  { selector: "main", source: "main" },
  { selector: ".md-content", source: ".md-content" },
  { selector: ".theme-doc-markdown", source: ".theme-doc-markdown" },
  { selector: '[role="main"]', source: '[role="main"]' },
  { selector: "#main-content", source: "#main-content" },
  { selector: ".markdown-body", source: ".markdown-body" },
  { selector: ".content", source: ".content" },
] as const;
const localHtmlStripSelectors = [
  "nav",
  "aside",
  "footer",
  "header",
  "script",
  "style",
  '[role="navigation"]',
  '[role="banner"]',
  ".sidebar",
  ".side-nav",
  ".toc",
  ".table-of-contents",
  ".contents",
  ".skip-link",
  ".skip-to-content",
  ".theme-doc-toc-desktop",
  ".theme-doc-toc-mobile",
  ".VPDocAside",
  ".vp-doc-aside",
  ".starlight-toc",
  "[data-pagefind-ignore]",
] as const;
// 300 chars rejects measured SPA redirect shells around 114 bytes while staying well below even terse real docs pages.
const localHtmlMinimumTextLength = 300;

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

turndownService.addRule("fencedCode", {
  filter: (node) => node.nodeName === "PRE",
  replacement: (_content, node: any) => {
    // linkedom elements do not line up cleanly with turndown's DOM types here.
    const code = node.textContent || "";
    const lang = resolveLocalHtmlFenceLanguage(node);
    return `\n\n\`\`\`${lang}\n${code.replace(/\n$/, "")}\n\`\`\`\n\n`;
  },
});

export function looksLikeMarkdown(body: string): boolean {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("#")) return true;
  const headingCount = (trimmed.match(/^#{2,6}\s/gm) || []).length;
  return headingCount >= 2;
}

export function looksLikeSoft404(body: string): boolean {
  const firstChunk = body.slice(0, 2000);
  if (/^#\s*404\b/im.test(firstChunk)) return true;
  if (/^#\s*page\s*not\s*found/im.test(firstChunk)) return true;
  if (/^<title>.*404.*<\/title>/im.test(firstChunk)) return true;
  const wordCount = firstChunk.split(/\s+/).length;
  if (wordCount < 50 && /not\s*found|does\s*not\s*exist/i.test(firstChunk)) return true;
  return false;
}

export function slugifyPath(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return path
    .replace(/\//g, "_")
    .replace(/^_+|_+$/g, "")
    || "index";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLocalHtmlText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resolveLocalHtmlFenceLanguage(pre: any): string {
  const code = pre.querySelector?.("code");
  const classCandidates = [
    code?.getAttribute?.("class") || "",
    pre.getAttribute?.("class") || "",
  ];

  for (const value of classCandidates) {
    const match = value.match(/(?:^|\s)language-([a-z0-9]+)/i);
    if (match) return match[1];
  }

  const attributeCandidates = [
    pre.getAttribute?.("data-language"),
    pre.getAttribute?.("data-lang"),
    code?.getAttribute?.("data-language"),
    code?.getAttribute?.("data-lang"),
  ];

  for (const value of attributeCandidates) {
    if (value) return value;
  }

  let current = pre.parentElement || pre.parentNode;
  let depth = 0;
  // Cap the ancestor walk so we stay within the immediate syntax-highlighter wrappers.
  while (current && depth < 5) {
    const match = (current.getAttribute?.("class") || "").match(/(?:^|\s)language-([a-z0-9]+)/i);
    if (match) return match[1];
    current = current.parentElement || current.parentNode;
    depth += 1;
  }

  return "";
}

function stripLocalHtmlChrome(root: Element): void {
  for (const selector of localHtmlStripSelectors) {
    for (const node of root.querySelectorAll(selector)) {
      node.remove();
    }
  }
}

function pickLocalHtmlSelectorBlock(document: Document): LocalHtmlExtraction | null {
  let bestMatch: LocalHtmlExtraction | null = null;

  for (const candidate of localHtmlSelectorCandidates) {
    for (const match of document.querySelectorAll(candidate.selector)) {
      const cloned = match.cloneNode(true);
      if (cloned.nodeType !== 1) continue;
      const element = cloned as Element;
      stripLocalHtmlChrome(element);
      const text = normalizeLocalHtmlText(element.textContent || "");
      if (!text) continue;
      if (!bestMatch || text.length > bestMatch.text.length) {
        bestMatch = {
          contentHtml: element.innerHTML,
          source: candidate.source,
          text,
        };
      }
    }
  }

  return bestMatch;
}

function pickLocalHtmlReadabilityBlock(document: Document): LocalHtmlExtraction | null {
  const article = new Readability(document).parse();
  const contentHtml = article?.content?.trim();
  const text = normalizeLocalHtmlText(article?.textContent || "");
  if (!contentHtml || !text) return null;
  return {
    contentHtml,
    source: "readability",
    text,
  };
}

export function extractLocalHtmlContent(html: string): LocalHtmlExtraction | null {
  try {
    const { document } = parseHTML(html);
    const selectorBlock = pickLocalHtmlSelectorBlock(document);
    if (selectorBlock) return selectorBlock;
    return pickLocalHtmlReadabilityBlock(document);
  } catch {
    return null;
  }
}

export function convertLocalHtmlToMarkdown(contentHtml: string): string {
  return turndownService.turndown(contentHtml).trim();
}

export function passesLocalHtmlLengthGate(text: string): boolean {
  return normalizeLocalHtmlText(text).length >= localHtmlMinimumTextLength;
}

async function tryContentNegotiation(url: string): Promise<{ content: string; method: FetchMethod } | null> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "text/markdown" },
    });
    if (res.status !== 200) return null;
    const contentType = res.headers.get("content-type") || "";
    const body = await res.text();
    if (contentType.includes("markdown") || looksLikeMarkdown(body)) {
      return { content: body, method: "content-negotiation" };
    }
    return null;
  } catch {
    return null;
  }
}

async function tryMdSuffix(url: string): Promise<{ content: string; method: FetchMethod } | null> {
  const mdUrl = url.endsWith("/")
    ? url.slice(0, -1) + ".md"
    : url + ".md";
  try {
    const res = await fetchWithTimeout(mdUrl, {});
    if (res.status !== 200) return null;
    const body = await res.text();
    if (looksLikeMarkdown(body)) {
      return { content: body, method: "md-suffix" };
    }
    return null;
  } catch {
    return null;
  }
}

async function tryRtdSources(url: string): Promise<{ content: string; method: FetchMethod } | null> {
  const rtdPattern = /\/(en|latest|stable)\/([^?#]*)/;
  const match = url.match(rtdPattern);
  if (!match) return null;

  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.replace(/\/$/, "").split("/");
    // Find the version/lang segment and build _sources path
    const langIdx = pathParts.findIndex((p) => p === "en" || p === "latest" || p === "stable");
    if (langIdx === -1) return null;

    const afterLang = pathParts.slice(langIdx + 1).join("/") || "index";
    const sourcePath = pathParts.slice(0, langIdx + 1).join("/") + "/_sources/" + afterLang + ".md.txt";
    const sourceUrl = parsed.origin + sourcePath;

    const res = await fetchWithTimeout(sourceUrl, {});
    if (res.status !== 200) return null;
    const body = await res.text();
    return { content: body, method: "rtd-sources" };
  } catch {
    return null;
  }
}

async function tryLocalHtml(url: string): Promise<{ content: string; method: FetchMethod } | null> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        Accept: localHtmlAccept,
        "User-Agent": localHtmlUserAgent,
      },
    });
    if (res.status !== 200) return null;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("html")) return null;
    const body = await res.text();
    if (!body.trim()) return null;

    const extracted = extractLocalHtmlContent(body);
    if (!extracted) return null;
    if (!passesLocalHtmlLengthGate(extracted.text)) return null;

    const markdown = convertLocalHtmlToMarkdown(extracted.contentHtml);
    if (!markdown) return null;
    if (!looksLikeMarkdown(markdown)) return null;
    if (looksLikeSoft404(markdown)) return null;

    return { content: markdown, method: "local-html" };
  } catch {
    return null;
  }
}

let jinaRateLimiter: TokenBucket | null = null;

async function tryJina(
  url: string,
  config: RunConfig,
): Promise<{ content: string; method: FetchMethod } | null> {
  if (!jinaRateLimiter) {
    const rpm = config.jinaApiKey ? 500 : 20;
    jinaRateLimiter = new TokenBucket(rpm);
  }
  await jinaRateLimiter.acquire();

  const headers: Record<string, string> = {
    "X-Return-Format": "markdown",
    "X-Retain-Images": "none",
    "X-Remove-Selector": "nav, footer, .sidebar, aside, [role=navigation], [role=banner], .cookie-banner, .consent-banner",
  };
  if (config.jinaApiKey) {
    headers["Authorization"] = `Bearer ${config.jinaApiKey}`;
  }

  try {
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers });
    if (res.status !== 200) return null;
    const body = await res.text();
    if (!body.trim()) return null;
    return { content: body, method: "jina" };
  } catch {
    return null;
  }
}

export async function fetchPage(url: string, config: RunConfig): Promise<FetchedPage> {
  const start = Date.now();

  const methods: Array<() => Promise<{ content: string; method: FetchMethod } | null>> = [
    () => tryContentNegotiation(url),
    () => tryMdSuffix(url),
    () => tryRtdSources(url),
    () => tryLocalHtml(url),
    () => tryJina(url, config),
  ];

  let lastSoft404Content: string | null = null;

  for (const tryMethod of methods) {
    try {
      const result = await tryMethod();
      if (result) {
        if (looksLikeSoft404(result.content)) {
          lastSoft404Content = result.content;
          continue; // skip this result, try next method
        }
        return {
          url,
          status: "ok",
          fetchMethod: result.method,
          wordsBefore: result.content.split(/\s+/).length,
          fetchDurationMs: Date.now() - start,
          content: result.content,
        };
      }
    } catch {
      // continue to next method
    }
  }

  return {
    url,
    status: "error",
    error: lastSoft404Content !== null
      ? "Soft-404 or login wall detected"
      : "All fetch methods failed",
    fetchDurationMs: Date.now() - start,
  };
}

export async function fetchPages(
  urls: string[],
  config: RunConfig,
  outputDir: string,
): Promise<PageResult[]> {
  const pagesDir = join(outputDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  const results: PageResult[] = [];
  let completed = 0;
  const total = urls.length;
  const concurrency = 10;
  let running = 0;

  // Semaphore-based concurrency control
  const queue = [...urls];
  const resultMap = new Map<string, PageResult>();
  const seenSlugs = new Set<string>();

  await new Promise<void>((resolve) => {
    function scheduleNext(): void {
      while (running < concurrency && queue.length > 0) {
        const url = queue.shift()!;
        running++;
        processPage(url).then(() => {
          running--;
          completed++;
          process.stderr.write(`\r[fetch] ${completed}/${total} pages fetched...`);
          if (queue.length === 0 && running === 0) {
            process.stderr.write("\n");
            resolve();
          } else {
            scheduleNext();
          }
        });
      }
    }

    async function processPage(url: string): Promise<void> {
      try {
        const fetched = await fetchPage(url, config);

        if (fetched.status === "ok" && fetched.content) {
          let slug = slugifyPath(url);
          if (seenSlugs.has(slug)) {
            let suffix = 2;
            while (seenSlugs.has(`${slug}_${suffix}`)) suffix++;
            slug = `${slug}_${suffix}`;
          }
          seenSlugs.add(slug);
          const filePath = join(pagesDir, `${slug}.md`);
          await writeFile(filePath, fetched.content, "utf-8");
          fetched.rawPath = `pages/${slug}.md`;
        }

        const { content: _, ...pageResult } = fetched;
        resultMap.set(url, pageResult);
      } catch (err) {
        resultMap.set(url, {
          url,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (queue.length === 0) {
      resolve();
    } else {
      scheduleNext();
    }
  });

  // Preserve original URL order
  for (const url of urls) {
    results.push(resultMap.get(url)!);
  }

  return results;
}

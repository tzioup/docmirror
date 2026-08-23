import { test, expect, describe, afterEach } from "bun:test";
import { discover, splitFrontier, LINK_CRAWL_FRONTIER_CAP } from "./discover.ts";
import type { RunConfig } from "./types.ts";

/**
 * Defect (c) of issue #1: the depth-1 crawl caps its frontier at 50 root links.
 * Links past the cap are retained in the output but never opened, so their
 * subtrees are never discovered — yet `discovery.partial` was set only on
 * cascade fall-through, so a crawl that succeeded while abandoning those
 * subtrees reported itself complete.
 */

const BASE = "https://docs.test/";

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    url: BASE,
    outputDir: "/dev/null",
    lang: "en",
    excludePaths: [],
    forceMap: false,
    condense: false,
    condenseModel: "haiku",
    condenseConcurrency: 1,
    topN: 10,
    ...overrides,
  };
}

function rootHtmlWith(linkCount: number): string {
  const links = Array.from(
    { length: linkCount },
    (_, i) => `<a href="/docs/page-${i + 1}">Page ${i + 1}</a>`,
  ).join("\n");
  return `<html><body><nav>${links}</nav></body></html>`;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A doc site that exposes no llms.txt and no sitemap, so the cascade is forced
 * down to stage 4 (link crawl), with `linkCount` links on its root page and
 * nothing below them.
 */
function stubLinkCrawlOnlySite(linkCount: number): { fetches: string[] } {
  const fetches: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    fetches.push(url);

    if (url === BASE || url === BASE.replace(/\/$/, "")) {
      return new Response(rootHtmlWith(linkCount), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.includes("/docs/page-")) {
      // A leaf: reachable, but contributes no further links.
      return new Response("<html><body><p>leaf</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    // llms-full.txt, llms.txt, every sitemap probe.
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetches };
}

describe("splitFrontier", () => {
  test("separates the links that get opened from the ones only kept", () => {
    const links = Array.from({ length: 60 }, (_, i) => `https://docs.test/p${i}`);
    const { toFollow, unfollowed } = splitFrontier(links);

    expect(toFollow).toHaveLength(LINK_CRAWL_FRONTIER_CAP);
    expect(unfollowed).toHaveLength(60 - LINK_CRAWL_FRONTIER_CAP);
    expect(unfollowed[0]).toBe(`https://docs.test/p${LINK_CRAWL_FRONTIER_CAP}`);
  });

  test("leaves nothing unfollowed when the frontier fits under the cap", () => {
    const links = Array.from({ length: 12 }, (_, i) => `https://docs.test/p${i}`);
    const { toFollow, unfollowed } = splitFrontier(links);

    expect(toFollow).toHaveLength(12);
    expect(unfollowed).toHaveLength(0);
  });
});

describe("discover — the frontier cap must mark the result partial", () => {
  test("sets discovery.partial when the 50-link crawl cap actually bit", async () => {
    stubLinkCrawlOnlySite(60);

    const result = await discover(BASE, config());

    expect(result.method).toBe("link-crawl");
    expect(result.partial).toBe(true);
  });

  test("names the abandoned links so the loss is countable, not just flagged", async () => {
    stubLinkCrawlOnlySite(60);

    const result = await discover(BASE, config());

    expect(result.unfollowedUrls).toBeDefined();
    expect(result.unfollowedUrls).toHaveLength(60 - LINK_CRAWL_FRONTIER_CAP);
    expect(result.metadata.partialReason).toBe("link-crawl-frontier-cap");
  });

  test("leaves a crawl that never hit the cap unmarked, so partial still means something", async () => {
    stubLinkCrawlOnlySite(30);

    const result = await discover(BASE, config());

    expect(result.method).toBe("link-crawl");
    expect(result.partial).toBeUndefined();
    expect(result.unfollowedUrls).toBeUndefined();
  });

  test("opens only the capped number of root links, leaving the rest unvisited", async () => {
    const { fetches } = stubLinkCrawlOnlySite(60);

    await discover(BASE, config());

    const opened = new Set(fetches.filter((u) => u.includes("/docs/page-")));
    expect(opened.size).toBe(LINK_CRAWL_FRONTIER_CAP);
    expect(opened.has(`${BASE}docs/page-60`)).toBe(false);
  });
});

import { createHash } from "node:crypto";

export interface PostcompileStats {
  pagesIn: number;
  pagesOut: number;
  pagesDropped: number;
  blocksDeduped: number;
  headingsNormalised: number;
}

interface PageEntry {
  url: string;
  title: string;
  content: string;
  pathSegments: string[];
}

function urlToPathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return ["unknown"];
  }
}

function hashBlock(text: string): string {
  return createHash("md5").update(text.trim()).digest("hex");
}

function splitIntoBlocks(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of content.split("\n")) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }

  return blocks;
}

function deduplicateBlocks(pages: PageEntry[]): { pages: PageEntry[]; blocksRemoved: number } {
  const seenHashes = new Map<string, string>();
  let blocksRemoved = 0;

  const result = pages.map((page) => {
    const blocks = splitIntoBlocks(page.content);
    const kept: string[] = [];

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed || trimmed.length < 40) {
        kept.push(block);
        continue;
      }

      const hash = hashBlock(trimmed);
      const firstSeen = seenHashes.get(hash);

      if (firstSeen && firstSeen !== page.url) {
        blocksRemoved++;
        continue;
      }

      seenHashes.set(hash, page.url);
      kept.push(block);
    }

    const newContent = kept.join("\n").trim();
    if (!newContent || newContent.split(/\s+/).length < 10) {
      return null;
    }

    return { ...page, content: newContent };
  });

  return {
    pages: result.filter((p): p is PageEntry => p !== null),
    blocksRemoved,
  };
}

function dropDuplicatePages(pages: PageEntry[]): { pages: PageEntry[]; dropped: number } {
  const seen = new Set<string>();
  const kept: PageEntry[] = [];
  let dropped = 0;

  for (const page of pages) {
    const hash = hashBlock(page.content);
    if (seen.has(hash)) {
      dropped++;
      continue;
    }
    seen.add(hash);
    kept.push(page);
  }

  return { pages: kept, dropped };
}

function normaliseHeadings(content: string, baseLevel: number): { content: string; count: number } {
  let count = 0;
  const lines = content.split("\n");
  const result: string[] = [];

  let minLevel = 6;
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s/);
    if (match) {
      minLevel = Math.min(minLevel, match[1].length);
    }
  }

  const shift = baseLevel - minLevel;
  if (shift === 0) return { content, count: 0 };

  for (const line of lines) {
    const match = line.match(/^(#{1,6})(\s.+)/);
    if (match) {
      const currentLevel = match[1].length;
      const newLevel = Math.min(6, Math.max(1, currentLevel + shift));
      result.push("#".repeat(newLevel) + match[2]);
      if (newLevel !== currentLevel) count++;
    } else {
      result.push(line);
    }
  }

  return { content: result.join("\n"), count };
}

function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function buildGroupedToc(pages: PageEntry[]): string {
  const groups = new Map<string, PageEntry[]>();

  for (const page of pages) {
    const group = page.pathSegments[0] || "root";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(page);
  }

  const lines: string[] = [];
  let sectionNum = 0;

  for (const [group, groupPages] of groups) {
    if (groups.size > 1 && groupPages.length > 1) {
      sectionNum++;
      const groupTitle = group.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`${sectionNum}. **${groupTitle}**`);
      for (const page of groupPages) {
        const cleanTitle = stripMarkdownLinks(page.title);
        const anchor = slugify(cleanTitle);
        lines.push(`   - [${cleanTitle}](#${anchor})`);
      }
    } else {
      for (const page of groupPages) {
        sectionNum++;
        const cleanTitle = stripMarkdownLinks(page.title);
        const anchor = slugify(cleanTitle);
        lines.push(`${sectionNum}. [${cleanTitle}](#${anchor})`);
      }
    }
  }

  return lines.join("\n");
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function postcompile(
  compiled: string,
  name: string,
  sourceUrl: string,
): { output: string; stats: PostcompileStats } {
  const pageSections = compiled.split(/\n---\n/).filter((s) => s.trim());

  pageSections.shift();

  const pages: PageEntry[] = [];
  for (const section of pageSections) {
    const pageMatch = section.match(/## Page: (.+?) \(source: (.+?)\)/);
    if (!pageMatch) continue;

    const title = pageMatch[1];
    const url = pageMatch[2];
    const content = section.slice(section.indexOf("\n", section.indexOf(pageMatch[0])) + 1).trim();

    pages.push({
      url,
      title: stripMarkdownLinks(title),
      content,
      pathSegments: urlToPathSegments(url),
    });
  }

  const pagesIn = pages.length;

  const { pages: dedupedPages } = dropDuplicatePages(pages);
  const { pages: blockDedupedPages, blocksRemoved } = deduplicateBlocks(dedupedPages);

  let headingsNormalised = 0;
  const normalisedPages = blockDedupedPages.map((page) => {
    const { content, count } = normaliseHeadings(page.content, 3);
    headingsNormalised += count;
    return { ...page, content };
  });

  const toc = buildGroupedToc(normalisedPages);
  const date = new Date().toISOString().split("T")[0];

  const sections = normalisedPages
    .map((p) => `## ${p.title}\n\n${p.content.trim()}`)
    .join("\n\n---\n\n");

  const output = `# ${name} — Reference Documentation
<!-- Assembled from ${pagesIn} pages, ${pagesIn - normalisedPages.length} dropped as duplicates, ${blocksRemoved} duplicate blocks removed -->

> Source: ${sourceUrl} | ${date}
> ${normalisedPages.length} pages after deduplication

## Table of Contents

${toc}

---

${sections}
`;

  return {
    output,
    stats: {
      pagesIn,
      pagesOut: normalisedPages.length,
      pagesDropped: pagesIn - normalisedPages.length,
      blocksDeduped: blocksRemoved,
      headingsNormalised,
    },
  };
}

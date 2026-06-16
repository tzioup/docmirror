import type { RunManifest } from "./types.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

function extractTitle(content: string): string | null {
  const match = content.match(/^# (.+)/m);
  return match ? match[1].trim() : null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function urlToSlug(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
    return path || "index";
  } catch {
    return "unknown";
  }
}

function anchorId(title: string): string {
  return slugify(title);
}

export function estimateTokens(text: string): number {
  // Count CJK characters (each ~ 1-2 tokens)
  const cjkChars = (text.match(/[　-鿿豈-﫿︰-﹏]/g) || []).length;
  // Count code blocks (denser tokenization, ~2.0 tokens/word)
  const codeBlockContent = (text.match(/```[\s\S]*?```/g) || []).join("");
  const codeWords = codeBlockContent.split(/\s+/).filter((w) => w.length > 0).length;
  // Count prose words (remaining after subtracting code)
  const totalWords = text.split(/\s+/).filter((w) => w.length > 0).length;
  const proseWords = totalWords - codeWords;

  return Math.round(proseWords * 1.33 + codeWords * 2.0 + cjkChars * 1.5);
}

function sortPageEntries(
  entries: Array<[string, string]>,
): Array<[string, string]> {
  return entries.sort(([urlA], [urlB]) => {
    const pathA = urlToSlug(urlA);
    const pathB = urlToSlug(urlB);

    if (pathA === "index" || pathA === "") return -1;
    if (pathB === "index" || pathB === "") return 1;
    return pathA.localeCompare(pathB);
  });
}

function firstPathSegment(url: string): string {
  const slug = urlToSlug(url);
  const first = slug.split("/")[0];
  return first || "root";
}

export function compile(
  cleanPages: Map<string, string>,
  manifest: RunManifest,
  outputDir: string,
): string {
  const sorted = sortPageEntries([...cleanPages.entries()]);

  const pageEntries = sorted.map(([url, content]) => {
    const title = extractTitle(content) || slugify(urlToSlug(url));
    return { url, content, title };
  });

  const tokenEstimate = estimateTokens(pageEntries.map((p) => p.content).join("\n"));

  const date = new Date().toISOString().split("T")[0];
  const name = manifest.name;

  const toc = pageEntries
    .map((p) => `- [${p.title}](#${anchorId(p.title)})`)
    .join("\n");

  const sections = pageEntries
    .map(
      (p) =>
        `## Page: ${p.title} (source: ${p.url})\n\n${p.content.trim()}`,
    )
    .join("\n\n---\n\n");

  const compiled = `# ${name} Documentation

> Mirrored from ${manifest.url} on ${date}
> ${pageEntries.length} pages | ~${tokenEstimate.toLocaleString()} tokens

## Table of Contents

${toc}

---

${sections}
`;

  mkdirSync(outputDir, { recursive: true });
  const compiledPath = join(outputDir, `${slugify(name)}-docs-compiled.md`);
  Bun.write(compiledPath, compiled);

  const sectionsDir = join(outputDir, "sections");
  mkdirSync(sectionsDir, { recursive: true });

  for (const entry of pageEntries) {
    const segment = firstPathSegment(entry.url);
    const segmentDir = join(sectionsDir, segment);
    mkdirSync(segmentDir, { recursive: true });

    const filename = `${slugify(entry.title)}.md`;
    Bun.write(join(segmentDir, filename), entry.content);
  }

  process.stderr.write(
    `[compile] Compiled ${pageEntries.length} pages → ${tokenEstimate.toLocaleString()} tokens\n`,
  );

  return compiled;
}

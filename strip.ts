import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CleanResult, PlatformDetection } from "./types.ts";
import { detectFlags } from "./flags.ts";
import { genericStrategy } from "./strategies/generic.ts";
import { gitbookStrategy } from "./strategies/gitbook.ts";
import { docusaurusStrategy } from "./strategies/docusaurus.ts";
import { readthedocsStrategy } from "./strategies/readthedocs.ts";
import { mintlifyStrategy } from "./strategies/mintlify.ts";
import { mkdocsStrategy } from "./strategies/mkdocs.ts";

type Strategy = (content: string) => CleanResult;

const STRATEGY_MAP: Record<string, Strategy> = {
  gitbook: gitbookStrategy,
  docusaurus: docusaurusStrategy,
  readthedocs: readthedocsStrategy,
  sphinx: readthedocsStrategy,
  mintlify: mintlifyStrategy,
  mkdocs: mkdocsStrategy,
  "mkdocs-material": mkdocsStrategy,
};

function hasUsableContent(text: string): boolean {
  const lines = text.split("\n");
  const hasHeading = lines.some((l) => /^#{1,6} /.test(l));
  const hasProse = lines.some(
    (l) =>
      l.trim().length > 40 &&
      !l.startsWith("#") &&
      !l.startsWith("[") &&
      !l.startsWith("*") &&
      !l.startsWith("-") &&
      !/^\d+\./.test(l.trim()),
  );
  return hasHeading || hasProse;
}

export function stripPage(content: string, platform: PlatformDetection): CleanResult {
  const strategy = STRATEGY_MAP[platform.platform.toLowerCase()] ?? genericStrategy;
  const result = strategy(content);

  if (!hasUsableContent(result.content) && result.content.trim().length < 50) {
    return {
      content,
      removed: [...result.removed, `QUALITY GATE: cleaned content has no headings or prose (${result.content.trim().length} chars), returning original`],
      qualityGateFailed: true,
    };
  }

  return result;
}

export interface StripPageResult extends CleanResult {
  flags: string[];
}

export function stripPages(
  pages: Map<string, string>,
  platform: PlatformDetection,
  outputDir: string,
): Map<string, StripPageResult> {
  const cleanDir = join(outputDir, "clean");
  mkdirSync(cleanDir, { recursive: true });

  const results = new Map<string, StripPageResult>();
  const total = pages.size;
  let done = 0;

  for (const [slug, raw] of pages) {
    const result = stripPage(raw, platform);
    const lines = result.content.split("\n");
    const flags = detectFlags(lines, raw, result);
    results.set(slug, { ...result, flags });

    writeFileSync(join(cleanDir, `${slug}.md`), result.content, "utf-8");

    done++;
    if (done % 10 === 0 || done === total) {
      process.stderr.write(`[strip] ${done}/${total} pages cleaned...\n`);
    }
  }

  return results;
}

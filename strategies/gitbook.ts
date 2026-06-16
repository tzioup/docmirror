import type { CleanResult } from "../types.ts";
import { genericStrategy } from "./generic.ts";

const GITBOOK_FOOTER_PATTERNS = [
  /Powered by GitBook/i,
  /Last modified/i,
];

const GITBOOK_TOC_HEADER = /^(On this page|Table of contents|In this article)$/i;

export function gitbookStrategy(content: string): CleanResult {
  const removed: string[] = [];
  const lines = content.split("\n");
  const filtered: string[] = [];

  let inTocBlock = false;
  let inNavBlock = false;
  let navRunLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Strip "Powered by GitBook" and "Last modified" lines
    if (GITBOOK_FOOTER_PATTERNS.some((p) => p.test(trimmed))) {
      removed.push(`gitbook footer: '${trimmed.slice(0, 60)}'`);
      continue;
    }

    // Strip page-level TOC blocks (header + indented links)
    if (GITBOOK_TOC_HEADER.test(trimmed)) {
      inTocBlock = true;
      removed.push("gitbook page TOC");
      continue;
    }
    if (inTocBlock) {
      if (trimmed === "" || /^\[/.test(trimmed) || /^\*/.test(trimmed) || /^- /.test(trimmed)) {
        continue;
      }
      inTocBlock = false;
    }

    // Strip GitBook-style navigation blocks (groups of links preceded by a bold/plain label)
    if (/^\*\*[^*]+\*\*$/.test(trimmed) && i + 1 < lines.length) {
      const nextTrimmed = lines[i + 1].trim();
      if (/^\[.+\]\(.+\)$/.test(nextTrimmed)) {
        inNavBlock = true;
        navRunLength = 0;
        removed.push(`gitbook nav section: '${trimmed.slice(0, 40)}'`);
        continue;
      }
    }
    if (inNavBlock) {
      if (/^\[.+\]\(.+\)$/.test(trimmed) || trimmed === "") {
        navRunLength++;
        continue;
      }
      if (/^\*\*[^*]+\*\*$/.test(trimmed)) {
        navRunLength = 0;
        continue;
      }
      inNavBlock = false;
    }

    filtered.push(line);
  }

  const platformCleaned = filtered.join("\n");
  const result = genericStrategy(platformCleaned);

  return {
    content: result.content,
    removed: [...removed, ...result.removed],
    qualityGateFailed: false,
  };
}

import type { CleanResult } from "../types.ts";
import { genericStrategy } from "./generic.ts";

const DOCUSAURUS_FOOTER_PATTERNS = [
  /Built with Docusaurus/i,
  /Powered by Docusaurus/i,
];

const PAGINATION_PATTERN = /^(Previous|Next)$/i;
const EDIT_LINK_PATTERN = /^(\[)?Edit this page/i;
const SIDEBAR_PATTERNS = [
  /^Docs$/i,
  /^API$/i,
  /^Blog$/i,
  /^Community$/i,
];

export function docusaurusStrategy(content: string): CleanResult {
  const removed: string[] = [];
  const lines = content.split("\n");
  const filtered: string[] = [];

  let inPaginationBlock = false;
  let paginationLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Strip Docusaurus footer
    if (DOCUSAURUS_FOOTER_PATTERNS.some((p) => p.test(trimmed))) {
      removed.push(`docusaurus footer: '${trimmed.slice(0, 60)}'`);
      continue;
    }

    // Strip "Edit this page" links
    if (EDIT_LINK_PATTERN.test(trimmed)) {
      removed.push("docusaurus edit link");
      continue;
    }

    // Strip pagination blocks ("Previous"/"Next" with adjacent link lines)
    if (PAGINATION_PATTERN.test(trimmed)) {
      inPaginationBlock = true;
      paginationLines = 0;
      removed.push(`docusaurus pagination: '${trimmed}'`);
      continue;
    }
    if (inPaginationBlock) {
      paginationLines++;
      if (/^\[.+\]\(.+\)$/.test(trimmed) || trimmed === "" || PAGINATION_PATTERN.test(trimmed)) {
        if (PAGINATION_PATTERN.test(trimmed)) {
          removed.push(`docusaurus pagination: '${trimmed}'`);
        }
        if (paginationLines > 4) inPaginationBlock = false;
        continue;
      }
      inPaginationBlock = false;
      filtered.push(line);
      continue;
    }

    // Strip sidebar nav remnants: short top-level nav labels followed by links
    if (SIDEBAR_PATTERNS.some((p) => p.test(trimmed))) {
      const nextTrimmed = (lines[i + 1] || "").trim();
      if (/^\[.+\]\(.+\)$/.test(nextTrimmed) || nextTrimmed === "") {
        removed.push(`docusaurus sidebar: '${trimmed}'`);
        continue;
      }
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

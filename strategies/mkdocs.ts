import type { CleanResult } from "../types.ts";
import { genericStrategy } from "./generic.ts";

const MKDOCS_FOOTER_PATTERNS = [
  /Made with Material for MkDocs/i,
  /Made with MkDocs/i,
  /Powered by MkDocs/i,
  /Documentation built with MkDocs/i,
  /Using the Material theme/i,
];

const SEARCH_OVERLAY_PATTERNS = [
  /^Type to start searching$/i,
  /^Initializing search$/i,
  /^Search$/i,
  /^No matching documents$/i,
];

const NAV_CHROME_PATTERNS = [
  /^Skip to content$/i,
  /^Back to top$/i,
  /^Toggle navigation$/i,
];

export function mkdocsStrategy(content: string): CleanResult {
  const removed: string[] = [];
  const lines = content.split("\n");
  const filtered: string[] = [];

  let inSearchOverlay = false;
  let searchOverlayLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Strip MkDocs/Material footer
    if (MKDOCS_FOOTER_PATTERNS.some((p) => p.test(trimmed))) {
      removed.push(`mkdocs footer: '${trimmed.slice(0, 60)}'`);
      continue;
    }

    // Strip nav chrome lines
    if (NAV_CHROME_PATTERNS.some((p) => p.test(trimmed))) {
      removed.push(`mkdocs nav chrome: '${trimmed}'`);
      continue;
    }

    // Strip search overlay remnants
    if (SEARCH_OVERLAY_PATTERNS.some((p) => p.test(trimmed))) {
      // "Search" alone is ambiguous — only strip if near other search overlay lines
      if (trimmed.toLowerCase() === "search") {
        const nearby = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
        if (!/Initializing|Type to start|No matching/i.test(nearby)) {
          filtered.push(line);
          continue;
        }
      }
      inSearchOverlay = true;
      searchOverlayLines = 0;
      removed.push(`mkdocs search overlay: '${trimmed}'`);
      continue;
    }
    if (inSearchOverlay) {
      searchOverlayLines++;
      if (trimmed === "" || SEARCH_OVERLAY_PATTERNS.some((p) => p.test(trimmed))) {
        if (searchOverlayLines > 5) inSearchOverlay = false;
        continue;
      }
      inSearchOverlay = false;
      filtered.push(line);
      continue;
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

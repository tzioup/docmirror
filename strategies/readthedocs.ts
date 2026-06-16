import type { CleanResult } from "../types.ts";
import { genericStrategy } from "./generic.ts";

const RTD_FOOTER_PATTERNS = [
  /Built with Sphinx/i,
  /Created using Sphinx/i,
  /Built with .* using a theme provided by Read the Docs/i,
  /Powered by Read the Docs/i,
  /Read the Docs v:/i,
];

const VERSION_SELECTOR_PATTERNS = [
  /^v:\s/i,
  /^Versions$/i,
  /^Latest$/i,
  /^Stable$/i,
  /^Languages$/i,
  /^Downloads$/i,
  /^On Read the Docs$/i,
  /^Project Home$/i,
  /^Builds$/i,
];

const RTD_NAV_PATTERNS = [
  /^Navigation$/i,
  /^Quick search$/i,
  /^Search docs$/i,
  /^Indices and tables$/i,
];

export function readthedocsStrategy(content: string): CleanResult {
  const removed: string[] = [];
  const lines = content.split("\n");
  const filtered: string[] = [];

  let inVersionSelector = false;
  let versionSelectorLines = 0;
  let inNavSection = false;
  let navSectionLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Strip Sphinx/RTD footer lines
    if (RTD_FOOTER_PATTERNS.some((p) => p.test(trimmed))) {
      removed.push(`rtd footer: '${trimmed.slice(0, 60)}'`);
      continue;
    }

    // Strip version selector blocks
    if (VERSION_SELECTOR_PATTERNS.some((p) => p.test(trimmed))) {
      inVersionSelector = true;
      versionSelectorLines = 0;
      removed.push(`rtd version selector: '${trimmed}'`);
      continue;
    }
    if (inVersionSelector) {
      versionSelectorLines++;
      if (/^\[.+\]\(.+\)$/.test(trimmed) || trimmed === "" || VERSION_SELECTOR_PATTERNS.some((p) => p.test(trimmed))) {
        if (versionSelectorLines > 10) inVersionSelector = false;
        continue;
      }
      inVersionSelector = false;
      filtered.push(line);
      continue;
    }

    // Strip RTD navigation sections
    if (RTD_NAV_PATTERNS.some((p) => p.test(trimmed))) {
      inNavSection = true;
      navSectionLines = 0;
      removed.push(`rtd nav: '${trimmed}'`);
      continue;
    }
    if (inNavSection) {
      navSectionLines++;
      if (/^\[.+\]\(.+\)$/.test(trimmed) || trimmed === "" || /^- /.test(trimmed) || /^\* /.test(trimmed)) {
        if (navSectionLines > 20) inNavSection = false;
        continue;
      }
      inNavSection = false;
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

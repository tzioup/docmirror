import type { CleanResult } from "../types.ts";
import { genericStrategy } from "./generic.ts";

const MINTLIFY_FOOTER_PATTERNS = [
  /Powered by Mintlify/i,
  /Built with Mintlify/i,
];

const API_CHROME_PATTERNS = [
  /^Authorization$/i,
  /^Bearer Token$/i,
  /^Header$/i,
  /^Query Parameters$/i,
  /^Path Parameters$/i,
  /^Body$/i,
  /^Responses$/i,
  /^curl --request/,
];

const SIDEBAR_META_PATTERNS = [
  /^Was this page helpful\?$/i,
  /^Suggest edits$/i,
  /^Raise issue$/i,
];

export function mintlifyStrategy(content: string): CleanResult {
  const removed: string[] = [];
  const lines = content.split("\n");
  const filtered: string[] = [];

  let inApiParamBlock = false;
  let paramBlockLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Strip Mintlify footer
    if (MINTLIFY_FOOTER_PATTERNS.some((p) => p.test(trimmed))) {
      removed.push(`mintlify footer: '${trimmed.slice(0, 60)}'`);
      continue;
    }

    // Strip sidebar metadata
    if (SIDEBAR_META_PATTERNS.some((p) => p.test(trimmed))) {
      removed.push(`mintlify sidebar meta: '${trimmed}'`);
      continue;
    }

    // Strip API reference chrome: parameter listing blocks that are pure
    // key/type/description tables rendered as repeated label lines
    if (inApiParamBlock) {
      paramBlockLines++;
      // Param blocks: lines like "string", "required", "integer", "optional", or blank
      if (/^(string|integer|number|boolean|object|array|required|optional)$/i.test(trimmed) || trimmed === "") {
        if (paramBlockLines > 30) inApiParamBlock = false;
        continue;
      }
      inApiParamBlock = false;
      filtered.push(line);
      continue;
    }

    // Detect start of API param blocks
    if (API_CHROME_PATTERNS.some((p) => p.test(trimmed))) {
      const nextTrimmed = (lines[i + 1] || "").trim();
      // Only strip if followed by type-like labels or blank lines
      if (/^(string|integer|number|boolean|object|array|required|optional)$/i.test(nextTrimmed) || nextTrimmed === "") {
        removed.push(`mintlify api chrome: '${trimmed}'`);
        inApiParamBlock = true;
        paramBlockLines = 0;
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

import type { CleanResult } from "../types.ts";

const FOOTER_PATTERNS = [
  /^Previous$/i,
  /^Next$/i,
  /Was this page (?:helpful|useful)/i,
  /Edit on GitHub/i,
  /Edit this page/i,
  /Suggest edits/i,
  /^Last updated/i,
  /^Last modified/i,
  /^On this page/i,
  /^Table of contents$/i,
  /^© /,
  /^Copyright/i,
  /^Released under /i,
  /^Licensed under /i,
  /^Pager$/i,
  /^\[(?:Previous|Next) (?:page )?/i,
  /^(?:#{1,6}\s+)?Did you find this (?:doc|page) useful/i,
];

const COOKIE_PATTERNS = [/cookie/i, /Accept all/i, /\bconsent\b/i, /privacy policy/i];


function isNavLink(line: string): boolean {
  const trimmed = line.trim();
  if (/^\[.+\]\(.+\)$/.test(trimmed)) return true;
  if (/^[*\-+]\s+\[.+\]\(.+\)\s*$/.test(trimmed)) return true;
  if (/^[*\-+]\s+\[.+\]\(https?:\/\/.+\)/.test(trimmed)) return true;
  if (/^[*\-+]\s+- \[x\]\s+\[.+\]\(.+\)/.test(trimmed)) return true;
  if (/^[*\-+]\s+\S+\s*$/.test(trimmed) && !trimmed.includes(".") && trimmed.length < 60) return true;
  return false;
}

function isBreadcrumb(line: string): boolean {
  return (line.match(/ > /g) || []).length >= 3;
}

function matchesFooterPattern(line: string): string | null {
  const trimmed = line.trim();
  for (const pattern of FOOTER_PATTERNS) {
    if (pattern.test(trimmed)) return trimmed;
  }
  return null;
}

export function genericStrategy(content: string): CleanResult {
  const removed: string[] = [];
  const lines = content.split("\n");

  // --- Strip HTML block tags and their content ---
  const postHtml: string[] = [];
  let inHtmlBlock: string | null = null;
  for (const line of lines) {
    if (inHtmlBlock) {
      const closePattern = new RegExp(`</${inHtmlBlock}[\\s>]`, "i");
      if (closePattern.test(line)) {
        inHtmlBlock = null;
      }
      continue;
    }
    const tagMatch = line.match(/^<(script|style|nav|footer)[\s>]/i);
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      removed.push(`html block: <${tag}>`);
      const closePattern = new RegExp(`</${tag}[\\s>]`, "i");
      if (!closePattern.test(line)) {
        inHtmlBlock = tag;
      }
      continue;
    }
    postHtml.push(line);
  }

  // --- Strip Jina Reader metadata preamble ---
  while (postHtml.length > 0 && /^(Title:|URL Source:|Markdown Content:)\s*/i.test(postHtml[0])) {
    postHtml.shift();
  }
  while (postHtml.length > 0 && postHtml[0].trim() === "") postHtml.shift();

  // --- Strip header chrome (everything before first heading) ---
  const firstHeadingIdx = postHtml.findIndex((l) => /^#{1,2} /.test(l));
  let working: string[];
  if (firstHeadingIdx > 0) {
    removed.push("header chrome");
    working = postHtml.slice(firstHeadingIdx);
  } else {
    working = [...postHtml];
  }

  // --- Strip post-heading nav preamble ---
  // Jina-converted pages often have a large nav/sidebar block right after the
  // title heading, before actual prose. Scan forward until we find real content
  // (a paragraph >80 chars, or a heading followed by a paragraph), stripping
  // everything in between if it's mostly nav-like.
  if (working.length > 0 && /^#{1,2} /.test(working[0])) {
    let contentStart = -1;
    let navLines = 0;
    let nonNavShortLines = 0;
    for (let i = 1; i < working.length; i++) {
      const t = working[i].trim();
      if (t === "" || t === "* * *" || t === "---") continue;

      // A second H1/H2 heading signals content start (Jina prepends sidebar TOC before repeating page title)
      if (/^#{1,2} /.test(t) && navLines >= 5) {
        contentStart = i;
        break;
      }

      const isNav = isNavLink(working[i])
        || /^\[!\[.*\]\(.*\)\]\(.*\)$/.test(t)
        || /^\[.+\]\(.+\)$/.test(t)
        || (t.startsWith("*") && t.length < 50 && !t.includes(". "))
        || /^\*\s*$/.test(t)
        || (/^\s+\*/.test(working[i]) && t.length < 60)
        || /- \[x\]\s+\[.+\]\(.+\)/.test(t)
        || /^on this page/i.test(t)
        || /^\d+\.\s+\[/.test(t);
      if (isNav) {
        navLines++;
        continue;
      }
      const isProse = t.length > 80 && !t.startsWith("[") && !t.startsWith("*") && !/^on this page/i.test(t);
      if (isProse || (/^#{1,6} /.test(t) && i + 1 < working.length && working[i + 1].trim().length > 40)) {
        contentStart = i;
        break;
      }
      nonNavShortLines++;
      if (nonNavShortLines > 5 && navLines < 3) break;
    }
    if (navLines >= 5 && contentStart > 0) {
      removed.push(`post-heading nav: ${navLines} nav lines after title`);
      working = [working[0], "", ...working.slice(contentStart)];
    }
  }

  // --- Strip breadcrumbs ---
  working = working.filter((line) => {
    if (isBreadcrumb(line)) {
      removed.push(`breadcrumb: "${line.trim().slice(0, 60)}"`);
      return false;
    }
    return true;
  });

  // --- Strip standalone "On this page" / "Skip to content" / "Back to top" / "Edit this page" ---
  working = working.filter((line) => {
    const t = line.trim();
    if (/^(?:#{1,6}\s+)?on this page\b/i.test(t)
      || /skip to (?:main )?content/i.test(t)
      || /^\[back to top\]/i.test(t)
      || /^back to top$/i.test(t)
      || /^\[edit this page\]/i.test(t)
      || /^copy markdown$/i.test(t)) {
      removed.push(`chrome label: "${t.slice(0, 60)}"`);
      return false;
    }
    return true;
  });

  // --- Strip cookie/consent banners ---
  working = working.filter((line) => {
    for (const pattern of COOKIE_PATTERNS) {
      if (pattern.test(line)) {
        removed.push(`cookie/consent: "${line.trim().slice(0, 60)}"`);
        return false;
      }
    }
    return true;
  });

  // --- Strip navigation chrome (5+ consecutive link-only lines) ---
  const navFiltered: string[] = [];
  let linkRun: string[] = [];

  const flushLinkRun = () => {
    if (linkRun.length >= 5) {
      removed.push(`nav block: ${linkRun.length} consecutive links`);
    } else {
      navFiltered.push(...linkRun);
    }
    linkRun = [];
  };

  for (const line of working) {
    if (isNavLink(line)) {
      linkRun.push(line);
    } else {
      flushLinkRun();
      navFiltered.push(line);
    }
  }
  flushLinkRun();
  working = navFiltered;

  // --- Strip empty link clusters (blocks of bare links with no prose) ---
  const linkClusterFiltered: string[] = [];
  let clusterBuf: string[] = [];

  for (let i = 0; i < working.length; i++) {
    const line = working[i];
    const trimmed = line.trim();
    const isBareLink = /^\[.+\]\(.+\)$/.test(trimmed);

    if (isBareLink) {
      clusterBuf.push(line);
    } else {
      if (clusterBuf.length > 0) {
        const prevLine = linkClusterFiltered[linkClusterFiltered.length - 1]?.trim() || "";
        const nextLine = trimmed;
        const prevIsProse = prevLine.length > 0 && !/^\[.+\]\(.+\)$/.test(prevLine);
        const nextIsProse = nextLine.length > 0 && !/^\[.+\]\(.+\)$/.test(nextLine);

        if (prevIsProse || nextIsProse || clusterBuf.length < 3) {
          linkClusterFiltered.push(...clusterBuf);
        } else {
          removed.push(`empty link cluster: ${clusterBuf.length} links`);
        }
        clusterBuf = [];
      }
      linkClusterFiltered.push(line);
    }
  }
  if (clusterBuf.length >= 3) {
    removed.push(`empty link cluster: ${clusterBuf.length} links`);
  } else {
    linkClusterFiltered.push(...clusterBuf);
  }
  working = linkClusterFiltered;

  // --- Strip footer chrome (from last footer pattern match to end, then walk up) ---
  // Only match in the back half of the document — a "footer" pattern near the top is content, not chrome
  const halfwayIdx = Math.floor(working.length / 2);
  let lastFooterIdx = -1;
  for (let i = working.length - 1; i >= halfwayIdx; i--) {
    const match = matchesFooterPattern(working[i]);
    if (match) {
      lastFooterIdx = i;
      removed.push(`footer: '${match.slice(0, 60)}'`);
      break;
    }
  }
  if (lastFooterIdx !== -1) {
    // Walk backward from the anchor to capture adjacent chrome (links, short lines, blanks, form elements)
    let cutIdx = lastFooterIdx;
    for (let i = lastFooterIdx - 1; i >= halfwayIdx; i--) {
      const t = working[i].trim();
      if (t === "") { cutIdx = i; continue; }
      if (matchesFooterPattern(working[i])) { cutIdx = i; continue; }
      if (/^\[.+\]\(.+\)$/.test(t)) { cutIdx = i; continue; }
      if (/^[*-]\s+\[.+\]\(.+\)$/.test(t)) { cutIdx = i; continue; }
      if (/^\* \* \*$/.test(t) || /^---$/.test(t)) { cutIdx = i; continue; }
      break;
    }
    working = working.slice(0, cutIdx);
  }

  // --- Deduplicate Jina title heading (title tag → H1 before content H1) ---
  const firstH1Idx = working.findIndex((l) => /^# /.test(l));
  if (firstH1Idx >= 0) {
    const normalizeH1 = (h: string) =>
      h.replace(/\s*[|\-–—]\s*.+$/, "")
        .replace(/\[¶\]\([^)]*\)/g, "")
        .replace(/\[​\]\([^)]*\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const firstH1 = normalizeH1(working[firstH1Idx]);
    for (let i = firstH1Idx + 1; i < working.length; i++) {
      if (/^# /.test(working[i])) {
        const secondH1 = normalizeH1(working[i]);
        if (firstH1 === secondH1 || secondH1.startsWith(firstH1) || firstH1.startsWith(secondH1)) {
          removed.push("duplicate title heading");
          working.splice(firstH1Idx, 1);
        }
        break;
      }
    }
  }

  // --- Strip numbered breadcrumbs (1. [Link] 2. [Link] ... N. PageTitle) ---
  const bcFiltered: string[] = [];
  let bcRun: string[] = [];
  for (const line of working) {
    if (/^\d+\.\s+\[/.test(line.trim()) || (/^\d+\.\s+\S/.test(line.trim()) && line.trim().length < 80)) {
      bcRun.push(line);
    } else {
      if (bcRun.length >= 2) {
        removed.push(`numbered breadcrumb: ${bcRun.length} items`);
      } else {
        bcFiltered.push(...bcRun);
      }
      bcRun = [];
      bcFiltered.push(line);
    }
  }
  if (bcRun.length >= 2) {
    removed.push(`numbered breadcrumb: ${bcRun.length} items`);
  } else {
    bcFiltered.push(...bcRun);
  }
  working = bcFiltered;

  // --- Collapse excessive blank lines (3+ → 2) ---
  const collapsed: string[] = [];
  let blankCount = 0;
  for (const line of working) {
    if (line.trim() === "") {
      blankCount++;
      if (blankCount <= 2) collapsed.push(line);
    } else {
      blankCount = 0;
      collapsed.push(line);
    }
  }

  return {
    content: collapsed.join("\n").trim(),
    removed,
    qualityGateFailed: false,
  };
}

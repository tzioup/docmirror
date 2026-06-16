import type { PlatformDetection } from "./types.ts";

interface PlatformSignature {
  name: string;
  urlPatterns: RegExp[];
  contentSignatures: string[];
  weight: number;
}

const PLATFORMS: PlatformSignature[] = [
  {
    name: "gitbook",
    urlPatterns: [/\.gitbook\.io/i],
    contentSignatures: [
      "powered by gitbook",
      "gitbook",
    ],
    weight: 2,
  },
  {
    name: "docusaurus",
    urlPatterns: [/\/docs\//i],
    contentSignatures: [
      "built with docusaurus",
      "docusaurus",
      "edit this page",
    ],
    weight: 2,
  },
  {
    name: "readthedocs",
    urlPatterns: [/readthedocs\.io/i, /readthedocs\.org/i],
    contentSignatures: [
      "built with sphinx",
      "read the docs",
      "sphinx-rtd-theme",
      "created using sphinx",
      "made with furo",
      "furo",
    ],
    weight: 2,
  },
  {
    name: "mintlify",
    urlPatterns: [/mintlify/i],
    contentSignatures: [
      "powered by mintlify",
      "mintlify",
    ],
    weight: 2,
  },
  {
    name: "mkdocs",
    urlPatterns: [],
    contentSignatures: [
      "made with material for mkdocs",
      "mkdocs",
    ],
    weight: 2,
  },
  {
    name: "vitepress",
    urlPatterns: [],
    contentSignatures: [
      "vitepress",
    ],
    weight: 2,
  },
  {
    name: "fumadocs",
    urlPatterns: [],
    contentSignatures: [
      "fumadocs",
    ],
    weight: 2,
  },
  {
    name: "nextra",
    urlPatterns: [],
    contentSignatures: [
      "nextra",
    ],
    weight: 2,
  },
];

const GENERIC_RESULT: PlatformDetection = {
  platform: "generic",
  confidence: 0,
  evidence: [],
};

function representativeSample(pages: string[], maxSample: number): string[] {
  if (pages.length <= maxSample) return pages;
  const indices = new Set<number>();
  indices.add(0);
  indices.add(pages.length - 1);
  const step = Math.floor(pages.length / maxSample);
  for (let i = 0; i < pages.length && indices.size < maxSample; i += step) {
    indices.add(i);
  }
  return [...indices].sort((a, b) => a - b).map(i => pages[i]);
}

export function detectPlatform(
  pages: string[],
  baseUrl: string,
): PlatformDetection {
  const sampled = representativeSample(pages, 10);
  const sampleCount = sampled.length;

  if (sampleCount === 0) return GENERIC_RESULT;

  const loweredPages = sampled.map((p) => p.toLowerCase());

  let bestPlatform = "";
  let bestScore = 0;
  let bestEvidence: string[] = [];

  for (const sig of PLATFORMS) {
    let score = 0;
    const evidence: string[] = [];

    // URL pattern check
    for (const pattern of sig.urlPatterns) {
      if (pattern.test(baseUrl)) {
        score += 3;
        evidence.push(`URL matches ${pattern.source}`);
        break;
      }
    }

    // Content signature check
    for (const signature of sig.contentSignatures) {
      const lowerSig = signature.toLowerCase();
      let hitCount = 0;

      for (const page of loweredPages) {
        if (page.includes(lowerSig)) {
          hitCount++;
        }
      }

      if (hitCount > 0) {
        score += sig.weight * hitCount;
        evidence.push(
          `${hitCount}/${sampleCount} pages contain '${signature}'`,
        );
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestPlatform = sig.name;
      bestEvidence = evidence;
    }
  }

  // Normalize confidence to 0.0–1.0
  // Max theoretical score: 3 (URL) + weight × signatures × sampleCount
  // Use a pragmatic ceiling: URL match (3) + 2 signature hits across all pages (2 × 2 × 5 = 20) = 23
  const maxReasonable = 3 + 2 * 2 * sampleCount;
  const confidence = Math.min(bestScore / maxReasonable, 1.0);

  if (confidence < 0.3) return GENERIC_RESULT;

  return {
    platform: bestPlatform,
    confidence: Math.round(confidence * 100) / 100,
    evidence: bestEvidence,
  };
}

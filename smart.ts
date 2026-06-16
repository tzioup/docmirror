const BM25_K1 = 1.5;
const BM25_B = 0.75;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "this", "that", "these", "those", "it", "its",
  "we", "you", "they", "he", "she", "not", "no", "as", "if", "then", "than",
  "so", "also", "can", "i", "my", "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

class BM25 {
  private idf: Map<string, number>;
  private avgdl: number;
  private N: number;
  private tokenizedDocs: string[][];
  private termFreq: Map<number, Map<string, number>>;

  constructor(docs: string[]) {
    this.tokenizedDocs = docs.map((d) => tokenize(d));
    this.N = docs.length;
    this.termFreq = new Map();

    const df = new Map<string, number>();
    for (let i = 0; i < this.tokenizedDocs.length; i++) {
      const tfMap = new Map<string, number>();
      for (const term of this.tokenizedDocs[i]) {
        tfMap.set(term, (tfMap.get(term) ?? 0) + 1);
      }
      this.termFreq.set(i, tfMap);
      for (const term of new Set(this.tokenizedDocs[i])) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    this.idf = new Map();
    for (const [term, docFreq] of df) {
      this.idf.set(
        term,
        Math.log((this.N - docFreq + 0.5) / (docFreq + 0.5) + 1),
      );
    }

    const totalLen = this.tokenizedDocs.reduce((s, t) => s + t.length, 0);
    this.avgdl = this.N > 0 ? totalLen / this.N : 1;
  }

  score(docIndex: number, queryTokens: string[]): number {
    const dl = this.tokenizedDocs[docIndex].length;
    const tfMap = this.termFreq.get(docIndex)!;
    let score = 0;

    for (const term of queryTokens) {
      const idf = this.idf.get(term) ?? 0;
      if (idf === 0) continue;
      const tf = tfMap.get(term) ?? 0;
      const numerator = tf * (BM25_K1 + 1);
      const denominator =
        tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgdl));
      score += idf * (numerator / denominator);
    }

    return score;
  }
}

export interface SmartPruneResult {
  pages: Map<string, string>;
  kept: number;
  dropped: number;
  droppedSlugs: string[];
  query: string;
}

export function smartPrune(
  pages: Map<string, string>,
  query: string,
  topN: number,
): SmartPruneResult {
  if (topN <= 0 || !query.trim() || pages.size <= topN) {
    return { pages, kept: pages.size, dropped: 0, droppedSlugs: [], query };
  }

  const slugs = [...pages.keys()];
  const docs = slugs.map((s) => pages.get(s)!);
  const bm25 = new BM25(docs);
  const queryTokens = tokenize(query);

  const scored = slugs.map((slug, i) => ({
    slug,
    score: bm25.score(i, queryTokens),
  }));

  // Safety fallback: if all scores are 0, return all pages
  if (scored.every((s) => s.score === 0)) {
    process.stderr.write(`[smart] All scores 0 for "${query}" — keeping all ${pages.size} pages (safety fallback)\n`);
    return { pages, kept: pages.size, dropped: 0, droppedSlugs: [], query };
  }

  scored.sort((a, b) => b.score - a.score);
  const kept = new Set(scored.slice(0, topN).map((s) => s.slug));
  const droppedSlugs = scored.slice(topN).map((s) => s.slug);

  const result = new Map<string, string>();
  for (const [slug, content] of pages) {
    if (kept.has(slug)) result.set(slug, content);
  }

  process.stderr.write(
    `[smart] Kept ${result.size}/${pages.size} pages by relevance to "${query}"\n`,
  );
  if (droppedSlugs.length > 0) {
    process.stderr.write(
      `[smart] Dropped ${droppedSlugs.length} pages: ${droppedSlugs.slice(0, 10).join(", ")}${droppedSlugs.length > 10 ? ` (+${droppedSlugs.length - 10} more)` : ""}\n`,
    );
  }
  return { pages: result, kept: result.size, dropped: droppedSlugs.length, droppedSlugs, query };
}

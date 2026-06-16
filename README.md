# DocMirror

Turn a doc site URL into a clean markdown corpus optimised for speedy and context-efficient LLM consumption.

## Why

Agents need docs. They need them locally, instantly, without web fetches — and they need them clean, not bloated with nav chrome and cookie banners that waste tokens. DocMirror caches any doc site as stripped markdown optimised for LLM consumption. When you work with a tool intensively, its docs are always available for agents to grep or pass through the CLI — no fumbling on the website trying to find the right section, no noisy or incomplete WebFetch, no stale search results, no hallucinated API signatures. 

The whole thing runs for free, in seconds for most doc sites. LLM condensing step is optional for scenarios where your agents access the docs with high enough frequency that shaving 20-30% of their size makes a difference. If you're not sure if that's you, that means it's not. 

The consumer is the LLM, not you. `--smart` and `--max-pages` are escape hatches for when you only need a slice.

## How It Works

**Discovery** — 5-stage pipeline, cheapest first:

| Stage | Method | Cost |
|-------|--------|------|
| 1 | `/llms-full.txt` | Free (1 req) — entire docs in one shot |
| 2 | `/llms.txt` | Free (1 req) — structured URL index |
| 3 | `sitemap.xml` | Free — URL enumeration |
| 4 | Link crawl from root | Free — follows one level deep |
| 5 | Firecrawl `/map` | API credits — last resort |

**Fetch** — per-page, 4 methods in priority order:
1. Content negotiation (`Accept: text/markdown`)
2. `.md` suffix on URL
3. ReadTheDocs `/_sources/*.md.txt`
4. Jina Reader (universal fallback, rate-limited to 500 RPM)

**Strip** — platform-detected noise removal. Platform-specific strategies for GitBook, Docusaurus, Sphinx/RTD, Mintlify, and MkDocs. Also detects VitePress, Fumadocs, and Nextra by signature but uses the generic strategy for them. Falls back to generic for unknown platforms.

**Condense** (optional, `--condense`) — LLM-powered per-page compression that removes filler prose while preserving code blocks, headings, and technical content. Three structural validators (code block count, heading count, word count) catch gross failures deterministically. Pages failing validation automatically fall back to the uncondensed version. Average reduction recorded during calibration: 20-30%. See [Condense](#condense) for details.

**Smart** (optional, `--smart <query>`) — BM25 lexical relevance scoring keeps only the top N pages most relevant to your query. Useful when a doc site has 500+ pages but you only need the auth section. Note: BM25 is keyword-based — it may miss pages that use synonyms or different phrasing than your query. Dropped pages are listed in stderr output.

**Validate** — JSON reports for cleanliness (residual noise), fidelity (content preservation), coverage (fetch completeness).

**Compile** — single markdown file with TOC, page separators, and token estimate. A deterministic post-compile step then deduplicates across pages, normalises headings, and builds a grouped TOC — runs in milliseconds regardless of corpus size.

## Usage

```bash
# Full mirror
bun docmirror.ts https://docs.example.com

# Mirror + condense (turns verbose blah into LLM-friendly efficient language, preserves all code/headings)
bun docmirror.ts https://docs.example.com --condense

# Smart subset — top 20 pages relevant to "authentication"
bun docmirror.ts https://docs.example.com --smart "authentication" --top 20

# Filter via Firecrawl search (requires FIRECRAWL_API_KEY)
bun docmirror.ts https://docs.example.com --filter "API reference"

# Single-run model override for Condense option (default: haiku)
bun docmirror.ts https://docs.example.com --condense --condense-model {model}

# Resume a failed run
bun docmirror.ts resume ./output/mylib-docs-20260515

# Inspect run state
bun docmirror.ts inspect ./output/mylib-docs-20260515
```

## Options

| Flag | Purpose |
|------|---------|
| `--name <name>` | Override default slug name |
| `--smart <query>` | Select top N pages by BM25 relevance to query |
| `--filter <query>` | Discover pages via Firecrawl search (requires API key) |
| `--condense` | LLM-condense each page (requires `DOCMIRROR_LLM_API_KEY` or Claude CLI) |
| `--condense-model <model>` | Model override for condensing (default: `DOCMIRROR_LLM_MODEL` env, or `haiku`) |
| `--condense-concurrency <n>` | Parallel condense workers (default: 3) |
| `--fabric <pattern>` | Pipe compiled output through a [Fabric](https://github.com/danielmiessler/fabric) pattern |
| `--top <n>` | Page count for --smart (default: 30) |
| `--lang <code>` | Language code (default: en) |
| `--exclude-path <paths>` | Comma-separated paths to exclude |
| `--force-map` | Force Firecrawl /map even if free methods work |
| `--max-pages <n>` | Hard cap on pages (opt-in only) |

## Environment

Copy `.env.example` to `.env` and fill in your keys:

| Variable | Purpose |
|----------|---------|
| `DOCMIRROR_OUTPUT` | Output directory (default: `./output`) |
| `JINA_API_KEY` | Jina Reader — 500 RPM (vs 20 without). Free tier. |
| `FIRECRAWL_API_KEY` | Firecrawl — used for `--filter` search and last-resort discovery |
| `DOCMIRROR_LLM_API_KEY` | API key for `--condense`. Works with any provider. Falls back to `ANTHROPIC_API_KEY`. |
| `DOCMIRROR_LLM_BASE_URL` | LLM API base URL. Default: Anthropic. Set to any OpenAI-compatible endpoint (OpenAI, Groq, ollama, Together, etc.) |
| `DOCMIRROR_LLM_MODEL` | Model ID for condensing. Default: `haiku`. Set once, applies to all runs. `--condense-model` overrides per-run. |

## Condense

The `--condense` flag runs each page through an LLM with a purpose-built prompt that removes filler prose while preserving technical content. Three deterministic validators run on every page:

1. **Code block count** — output must have ≥ input's ``` fence pairs
2. **Heading count** — output must have ≥ input's ## heading lines
3. **Word count** — output must not expand beyond 105% of input (expansion = hallucination)

Pages failing any validator automatically use the (stripped but) uncondensed version. The prompt is shipped at `prompts/condense-page.md`.

**Important limitation:** These validators check structure, not meaning. A condensed page that drops a caveat or inverts a negation ("do not use" → "use") will pass all three structural checks. Condense is a lossy compression — treat it accordingly.

**LLM setup (one-time):** Condense works with any LLM provider. Configure once in `.env`:

```bash
# Anthropic (default — just set the key)
DOCMIRROR_LLM_API_KEY=sk-ant-...

# OpenAI
DOCMIRROR_LLM_API_KEY=sk-...
DOCMIRROR_LLM_BASE_URL=https://api.openai.com/v1
DOCMIRROR_LLM_MODEL=gpt-4o-mini

# Local ollama
DOCMIRROR_LLM_BASE_URL=http://localhost:11434/v1
DOCMIRROR_LLM_MODEL=llama3.1
```

Provider is auto-detected from the base URL: `anthropic.com` → Anthropic Messages format, everything else → OpenAI Chat Completions format. If no API key is set, condense falls back to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude --print`). If neither is available, pages fall back to uncondensed output.

**Model selection:** The eval was done on Anthropic models (see below). Haiku is the default and cheapest. `--condense-model` overrides per-run; `DOCMIRROR_LLM_MODEL` sets the default. Fallback rates depend on content and model — the structural validators catch failures regardless of provider.

## Post-Compile Processing

After compilation, a deterministic post-compile step runs automatically: drops duplicate pages (exact content matches), removes duplicate content blocks across pages, normalises heading levels, and builds a grouped table of contents from URL path structure. No LLM needed — runs in milliseconds on any corpus size.

Tested on a 251-page corpus: 99 duplicate pages dropped, 18 cross-page blocks deduped, 3131 headings normalised in 35ms.

## Fabric

`--fabric <pattern>` pipes the final compiled output through a [Fabric](https://github.com/danielmiessler/fabric) pattern as an optional post-processing step. Requires `fabric` CLI installed separately.

The original compiled file is preserved as `.orig` before fabric runs. If fabric fails or produces empty output, the original is restored automatically.

**Note:** Cross-page assembly (dedup, TOC, heading normalisation) is now handled by the built-in post-compile step — no need for an LLM-based assembly pattern. `--fabric` is for custom transforms you want to apply on top.

## Output

```
output/{name}-docs-YYYYMMDD-HHMMSS/
  run.json                  ← per-page status, platform detection, timing
  {name}-docs-compiled.md   ← full corpus with TOC
  pages/                    ← raw fetched markdown
  clean/                    ← noise-stripped pages
  sections/                 ← by URL path segment
  reports/                  ← cleanliness.json, fidelity.json, coverage.json
```

## Condense Eval Results

The condense pipeline was calibrated through a structured eval harness: 20-case structural eval, GPT-4o AI judge scoring (fidelity + hallucination detection), full 194-page corpus run, concurrency calibration, and an independent cross-vendor code audit.

**Winning config: Haiku + v2.0.0-haiku prompt, concurrency 3.**

| Metric | Haiku v2.0.0 | Sonnet v2.0.0 |
|--------|-------------|---------------|
| Structural pass (20 cases) | **20/20 (100%)** | 19/20 (95%) |
| AI fidelity (GPT-4o judge) | **4.90/5** | 4.75/5 |
| Hallucination pass | **100%** | 100% |
| Avg reduction | 30% | 31% |

**Full corpus (194 Mintlify pages, c=3):** 90% pass rate, 23.4% avg reduction on passing pages. 19 fallbacks caught by validators (7 hallucination/expansion, 5 content gutting, 7 minor structural loss) — all fell back to uncondensed, none served broken. Pages under ~150 words skip condensation automatically (density gate).

**Prompt evolution:** v1.0.0 baseline (30% fallback) → v1.1.0 anti-consolidation rules (5%) → v2.0.0 heading preservation + self-check (0% on Haiku). The breakthrough was explicit structural preservation rules mirroring the code block fix, plus a self-check instruction that asks the model to count headings before outputting.

**Concurrency:** On Anthropic OAuth, c=3 gave 2.15x speedup with no quality loss.

## Architecture

```
docmirror.ts          CLI entry (Commander.js)
  ├── discover.ts     5-stage URL discovery + Firecrawl search (--filter)
  ├── fetch.ts        Content acquisition + Jina rate limiter
  ├── detect.ts       Confidence-scored platform detection
  ├── strip.ts        Strategy orchestrator + quality gate
  │   └── strategies/ Generic + GitBook, Docusaurus, Sphinx, Mintlify, MkDocs
  ├── smart.ts        BM25 relevance pruning (--smart)
  ├── condense.ts     LLM compression + structural validators (--condense)
  │   └── prompts/    Condense system prompt
  ├── validate.ts     Cleanliness, fidelity, coverage reports
  ├── compile.ts      Markdown assembly + TOC + token estimate
  ├── postcompile.ts  Cross-page dedup, heading normalisation, grouped TOC
  ├── flags.ts        Per-page quality flag detectors
  ├── types.ts        Shared type definitions
  └── state.ts        run.json manifest for resumability
```

## License

MIT

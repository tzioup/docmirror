# DocMirror

Turn a doc site URL into a clean markdown corpus optimised for speedy and context-efficient LLM consumption.

## Why

Agents need docs. They need them locally, instantly, without web fetches — and they need them clean, not bloated with nav chrome and cookie banners that waste tokens. DocMirror caches any doc site as stripped markdown optimised for LLM consumption. When you work with a tool intensively, its docs are always available for agents to grep or pass through the CLI — no fumbling on the website trying to find the right section, no noisy or incomplete WebFetch, no stale search results, no hallucinated API signatures.

The whole thing runs for free, in seconds for most doc sites. The consumer is the LLM, not you. `--smart` and `--max-pages` are escape hatches for when you only need a slice.

## Install

Requires [Bun](https://bun.sh). No other runtime, no global install.

```bash
git clone https://github.com/tzioup/docmirror && cd docmirror
bun install
bun docmirror.ts https://hono.dev
```

Nothing else is required. Every API key in [Environment](#environment) is optional and the tool runs without any of them.

## Evidence

Numbers below were produced by the scripts in [`evidence/`](evidence/) and can be re-run. The protocol, and the limits on what each figure supports, are in [`evidence/METHODOLOGY.md`](evidence/METHODOLOGY.md). Measured 2026-07-28; `--condense` was not used for any of it.

These drift: the live sites change under you. Re-measuring the same corpora 3.5 hours later moved bun's ratio from 64.2× to 66.1× with nothing on this side having changed. Treat the order of magnitude as the finding and the exact figure as perishable.

### What a doc page costs, front door vs mirrored

A sample of real documentation pages fetched as raw HTML, against the same pages mirrored:

| Source | Doc pages | Mean HTML page | Mean mirrored page | Ratio | Corpus total | Est. tokens |
|---|---:|---:|---:|---:|---:|---:|
| bun | 315 | 412 KB | 6 KB | **66×** | 1.9 MB | 324,443 |
| astro | 417 | 182 KB | 7 KB | **24×** | 500 KB ¹ | 89,288 ¹ |
| hono | 86 | 85 KB | 4 KB | **21×** | 356 KB | 76,974 |
| vitest | 191 | 90 KB | 6 KB | **15×** | 1.1 MB | 240,299 |
| fastapi | 151 | 216 KB | 20 KB | **11×** | 1.9 MB ¹ | 306,632 ¹ |

¹ **These two sources were mirrored with `--smart … --top 40`**, so their **Corpus total** and **Est. tokens** describe the 40 kept pages, not the whole site — astro kept 40 of 1928 stripped pages, fastapi 40 of 145. Do not read astro's row as "the whole of the Astro docs mirrors to 500 KB": the full stripped corpus is 14.1 MB. Every other column, the ratio included, is measured over the full page set, so the front-door comparison is unaffected. `measure.ts` reads the pruning out of each run's own `run.json` and marks the affected cells, so this cannot silently go missing on a re-run.

Token counts are docmirror's own estimate, read from each compiled file's header, rather than a second approximation computed here — a bytes-per-token rule of thumb disagrees with it by 40–65% and would leave a reader sizing a context budget with two different numbers for the same file.

### Where that saving actually comes from

Almost all of it is the *acquisition* step — taking markdown from the site instead of HTML, or converting HTML locally. The noise-stripping pass that runs afterwards is a small marginal gain on top:

| Source | Discovery | Pages stripped | Raw | Stripped | Stripping removed |
|---|---|---:|---:|---:|---:|
| astro | `sitemap` | 1928 | 14.7 MB | 14.1 MB | 4.1% |
| fastapi | `sitemap` | 145 | 2.9 MB | 2.9 MB | 1.5% |
| bun | `llms-full-txt` | — | 1.9 MB | 1.9 MB | n/a — fast path, no stripping |
| hono | `llms-full-txt` | — | 356 KB | 356 KB | n/a — fast path, no stripping |
| vitest | `llms-full-txt` | — | 1.1 MB | 1.1 MB | n/a — fast path, no stripping |

Two things follow, and both cut against a simple "DocMirror shrinks your docs by N%" claim:

- **When a site publishes `/llms-full.txt`, no stripping happens at all.** Discovery short-circuits to a single-file fast path and the run's own `run.json` records `"fidelity": "not applicable"`. Three of the five sources here take that route. On it you gain availability and latency, not smaller bytes.
- **On the strip path, stripping itself is worth single digits.** The pages it operates on are already markdown, so there is not much chrome left to remove. The order-of-magnitude number in the table above is earned before stripping runs.

Both figures compare like with like. The strip percentages are measured over the *same page set* on each side; comparing fetched bytes against the final compiled file would have counted `--smart` page-pruning as compression and reported astro at 96.7%, which is not a compression result.

### Does a local corpus actually beat fetching live?

Three arms, one frozen question set, same model (Sonnet), same deterministic grader. Only the tool surface differs — web-only, corpus-only, and a no-tools control:

| Arm | Correct | Median time | Median cost | Turns |
|---|---:|---:|---:|---:|
| **memory** — no tools, no docs | **0 / 10** | 1.9 s | $0.024 | 10 |
| **frontdoor** — WebFetch + WebSearch | **10 / 10** | 17.8 s | $0.110 | 43 |
| **cache** — grep a mirrored corpus | **10 / 10** | **7.0 s** | **$0.037** | 28 |

**Accuracy is a tie. The corpus buys ~2.5× on latency and ~3× on cost.** If someone tells you a docs cache makes an agent smarter, this run does not support that; it makes it faster and cheaper at the same answer.

The no-tools control is what makes the other two rows mean anything. At 0/10 it establishes that these questions are not answerable from the model's prior knowledge, so both sourced arms were genuinely reading their source rather than reciting. Without that row, two arms tying at 10/10 would be uninterpretable.

**One correction was made to the grading key after the first run, and it changed the headline.** Numeric answers were matched with `\bN\b`, which cannot match `50ms` — `\b` needs a non-word character, and `0`/`m` are both word characters. That failed the front-door arm's `**50ms**` while passing the cache arm's `` `50` ms ``, scoring **frontdoor 9/10 against cache 10/10**. Uncorrected, this page would be claiming a mirrored corpus is *more accurate than the live web*, from a regex bug rather than from anything about documentation. The fix was applied to both arms identically and both score sets are kept: [`evidence/METHODOLOGY.md`](evidence/METHODOLOGY.md#grading), and `key_corrections` in [`evidence/ab/questions.json`](evidence/ab/questions.json).

Raw records and per-question results: [`evidence/ab/runs/`](evidence/ab/runs/).

## How It Works

**Discovery** — 5-stage pipeline, cheapest first:

| Stage | Method | Cost |
|-------|--------|------|
| 1 | `/llms-full.txt` | Free (1 req) — entire docs in one shot |
| 2 | `/llms.txt` | Free (1 req) — structured URL index |
| 3 | `sitemap.xml` | Free — URL enumeration |
| 4 | Link crawl from root | Free — follows one level deep |
| 5 | Firecrawl `/map` | API credits — last resort |

Each stage is tried at the URL you gave *and* at the site's origin root, because a docs section and its `llms-full.txt` or `sitemap.xml` are frequently not at the same depth.

**Fetch** — per-page, 5 methods in priority order:
1. Content negotiation (`Accept: text/markdown`)
2. `.md` suffix on URL
3. ReadTheDocs `/_sources/*.md.txt`
4. Local HTML extraction (readability + turndown, no network service)
5. Jina Reader (universal fallback, rate-limited to 500 RPM)

**Strip** — platform-detected noise removal. Platform-specific strategies for GitBook, Docusaurus, Sphinx/RTD, Mintlify, and MkDocs. Also detects VitePress, Fumadocs, and Nextra by signature but uses the generic strategy for them. Falls back to generic for unknown platforms.

**Smart** (optional, `--smart <query>`) — BM25 lexical relevance scoring keeps only the top N pages most relevant to your query. Useful when a doc site has 500+ pages but you only need the auth section. Note: BM25 is keyword-based — it may miss pages that use synonyms or different phrasing than your query. Dropped pages are listed in stderr output.

**Validate** — JSON reports for cleanliness (residual noise), fidelity (content preservation), coverage (fetch completeness).

**Compile** — single markdown file with TOC, page separators, and token estimate. A deterministic post-compile step then deduplicates across pages, normalises headings, and builds a grouped TOC — runs in milliseconds regardless of corpus size.

## Usage

```bash
# Full mirror
bun docmirror.ts https://docs.example.com

# Mirror + condense (see the Condense section before relying on this)
bun docmirror.ts https://docs.example.com --condense

# Smart subset — top 20 pages relevant to "authentication"
bun docmirror.ts https://docs.example.com --smart "authentication" --top 20

# Filter via Firecrawl search (requires FIRECRAWL_API_KEY)
bun docmirror.ts https://docs.example.com --filter "API reference"

# Resume a failed run
bun docmirror.ts resume ./output/mylib-docs-20260515

# Inspect run state
bun docmirror.ts inspect ./output/mylib-docs-20260515
```

## Did it work?

A run that fetches nothing still exits and still writes a directory, so check rather than assume:

```bash
OUT=./output/mylib-docs-20260515

# 1. What discovery actually did, and how many pages landed.
jq '{discoveryMethod, platform, pages: (.pages|length)}' $OUT/run.json

# 2. Any page that did not come back cleanly.
jq -r '.pages[] | select(.status != "ok") | "\(.status)\t\(.url)"' $OUT/run.json

# 3. Does the corpus contain documentation, or just navigation?
grep -c '```' $OUT/*-compiled.md      # code blocks — near-zero on a reference-heavy
grep -c '^## ' $OUT/*-compiled.md     # site is the signal that stripping went wrong

# 4. The quality reports.
cat $OUT/reports/cleanliness.json $OUT/reports/coverage.json
```

The failure worth looking for is a corpus that is *large but empty* — a site whose `llms-full.txt` is a link index rather than prose will fill megabytes with `- [Title](url)` lines. Discovery rejects that shape, but the code-block and heading counts above are the check that catches the general case.

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

Copy `.env.example` to `.env` and fill in your keys. **All of these are optional** — with none of them set, discovery uses the free stages, fetching uses local extraction, and `--condense` falls back to the Claude CLI or to uncondensed output.

| Variable | Purpose |
|----------|---------|
| `DOCMIRROR_OUTPUT` | Output directory (default: `./output`) |
| `JINA_API_KEY` | Jina Reader — 500 RPM (vs 20 without). Free tier. |
| `FIRECRAWL_API_KEY` | Firecrawl — used for `--filter` search and last-resort discovery |
| `DOCMIRROR_LLM_API_KEY` | API key for `--condense`. Works with any provider. Falls back to `ANTHROPIC_API_KEY`. |
| `DOCMIRROR_LLM_BASE_URL` | LLM API base URL. Default: Anthropic. Set to any OpenAI-compatible endpoint (OpenAI, Groq, ollama, Together, etc.) |
| `DOCMIRROR_LLM_MODEL` | Model ID for condensing. Default: `haiku`. Set once, applies to all runs. `--condense-model` overrides per-run. |

## Condense

> **Treat this feature as an experiment we are sharing, not a product guarantee.**
> It produced good results for us and it is here as a starting point for your own
> experimentation. It is not something we can claim is deterministic or
> reproducible: too many variables move independently, several of them
> invisibly. **Run your own eval, with a QC step, before trusting any
> prompt × model pairing for anything with stakes.**

The `--condense` flag runs each page through an LLM with a purpose-built prompt that removes filler prose while preserving technical content. The prompt ships at [`prompts/condense-page.md`](prompts/condense-page.md) and carries its own version marker.

Three deterministic validators run on every page:

1. **Code block count** — output must have ≥ input's ``` fence pairs
2. **Heading count** — output must have ≥ input's ## heading lines
3. **Word count** — output must not expand beyond 105% of input (expansion = hallucination)

Pages failing any validator automatically use the (stripped but) uncondensed version.

**Important limitation:** these validators check structure, not meaning. A condensed page that drops a caveat or inverts a negation ("do not use" → "use") will pass all three structural checks. Condense is a lossy compression — treat it accordingly.

### Which billing path does it use?

Two paths, and which one you get depends on what is set:

| Condition | Path | What it costs |
|---|---|---|
| `DOCMIRROR_LLM_API_KEY` or `ANTHROPIC_API_KEY` set | Direct HTTP to the provider | **Metered API — you are billed per token** |
| Neither set, `claude` on `PATH` | `claude --print` subprocess | Whatever that CLI is authenticated with — a subscription rather than metered tokens |
| Neither available | No condensing | Pages fall through uncondensed |

The subprocess path deliberately strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child environment, so it cannot silently fall back to metered billing once you have chosen it. It also passes `--setting-sources ""`, so your own CLI settings files do not join the run.

**Provider is auto-detected from the base URL**: `anthropic.com` → Anthropic Messages format, everything else → OpenAI Chat Completions format.

### Results, and why they are indicative only

Measured during calibration through a structured eval harness: 20-case structural eval, GPT-4o AI judge scoring (fidelity + hallucination detection), full 194-page corpus run, concurrency calibration, and an independent cross-vendor code audit.

**Measured 2026-05. Winning config at the time: prompt v2.0.0 on the Haiku family, concurrency 3.** That date is load-bearing, not a footnote — every caveat below is about drift away from it, and the further you are from it the less the table is worth.

**The eval harness that produced this table is not in this repo**, and neither is its 194-page fixture corpus. So the numbers are reported, not reproducible from here — which is the honest reason the box above says run your own eval rather than trust these. What *is* here is the prompt (versioned), the validators (`condense.ts`), and a working three-arm A/B harness in [`evidence/ab/`](evidence/ab/) that is a reasonable template to adapt: frozen question set, deterministic grader, no model in the grading path.

| Metric | prompt v2.0.0 × Haiku | prompt v2.0.0 × Sonnet |
|--------|-------------|---------------|
| Structural pass (20 cases) | **20/20 (100%)** | 19/20 (95%) |
| AI fidelity (GPT-4o judge) | **4.90/5** | 4.75/5 |
| Hallucination pass | **100%** | 100% |
| Avg reduction | 30% | 31% |

**Full corpus (194 Mintlify pages, c=3):** 90% pass rate, 23.4% avg reduction on passing pages. 19 fallbacks caught by validators (7 hallucination/expansion, 5 content gutting, 7 minor structural loss) — all fell back to uncondensed, none served broken. Pages under ~150 words skip condensation automatically (density gate).

**Prompt evolution:** v1.0.0 baseline (30% fallback) → v1.1.0 anti-consolidation rules (5%) → v2.0.0 heading preservation + self-check (0% on Haiku). The breakthrough was explicit structural preservation rules mirroring the code block fix, plus a self-check instruction that asks the model to count headings before outputting.

**Concurrency:** on Anthropic OAuth, c=3 gave 2.15× speedup with no quality loss.

Now the caveats, which matter more than the table:

- **The two axes in that table are independent.** A row is a *prompt version* crossed with a *model*. Neither alone explains a score, and moving either moves the result. The prompt version is recorded in the prompt file; the model is not pinned.
- **`haiku` and `sonnet` are aliases, not snapshots.** They follow whatever the provider currently serves under that name. The same flag can mean a different model month to month.
- **Models change under a fixed name.** Providers revise serving stacks and system-level behaviour without changing the model id. A prompt that scored 20/20 can score differently later with nothing on your side having moved, and you will get no notification.
- **Your own context is a variable.** Where condense shells out to a CLI, that CLI's project instructions and settings can shape the output. The subprocess path passes `--setting-sources ""` for exactly this reason, but the cleanest way to remove the whole class is to **condense inside a sandboxed runner** — a container with no user config above it — so the result is a fact about the prompt and model rather than about your machine.
- **Corpus composition dominates.** Reduction depends on how much filler a given doc set contains. A terse API reference has little to remove; a tutorial-heavy site has a lot. A percentage from one corpus does not transfer to another.

## Fabric

**Fabric is entirely optional, and nothing in DocMirror requires it.** `--fabric` is the only code path that touches it. If the `fabric` CLI is not installed, that flag logs a warning and skips; every other feature is unaffected. You never need to install Fabric to use this tool.

`--fabric <pattern>` pipes the final compiled output through a [Fabric](https://github.com/danielmiessler/fabric) pattern as an optional post-processing step. The original compiled file is preserved as `.orig` before fabric runs; if fabric fails or produces empty output, the original is restored automatically.

Fabric is worth naming as the inspiration for the "pipe content through a named prompt pattern" shape that the condense step uses. Cross-page assembly (dedup, TOC, heading normalisation) is handled by the built-in post-compile step, so `--fabric` is for custom transforms you want to apply on top.

## Gotchas

- **A `/llms-full.txt` hit means no stripping happened.** Discovery short-circuits to a single-file fast path and the run reports `"fidelity": "not applicable"`. This is the intended behaviour — the file is already clean — but do not expect strip-path behaviour or a size reduction on those sources.
- **Point at the right URL.** Discovery probes both the path you give and the origin root, but the *page set* still comes from the URL you supply. Pointing at `https://vitest.dev/guide` when the corpus lives at the root can turn a single free GET into a multi-hundred-page crawl. If a run is unexpectedly slow, check `discoveryMethod` in `run.json` first.
- **Some sites publish a link index as `llms-full.txt`.** It is megabytes of `- [Title](url)` and contains no documentation. Discovery rejects that shape and falls through, which is correct but much slower than the fast path.
- **Reruns never overwrite.** Every run writes a new timestamped directory and nothing is cleaned up. On a repeated schedule this grows without bound; prune `output/` yourself.
- **`--smart` prunes after fetching, not before.** It cannot save you the crawl, only the corpus size.

## Boundaries

Deliberately not in scope:

- **No server, no API, no daemon.** The output is files. Search them with `rg`.
- **No scheduling or incremental refresh.** One invocation mirrors once. Keeping a corpus current is the caller's job.
- **No JS rendering.** Client-side-rendered docs that ship no content in HTML will not mirror well; that is what the Jina fallback is for.
- **No semantic search.** `--smart` is BM25 — lexical, not embeddings.
- **No accuracy guarantee from `--condense`.** See that section.

## What uses this

DocMirror is a CLI other things call, not a library. [`docmirror-cache`](https://github.com/tzioup/docmirror-cache) drives it on a schedule to keep a set of corpora current and publishes them for agents to clone. If you change the CLI surface — flag names, the `output/` layout, or `run.json`'s shape — that is the consumer to check.

## Extending

The seam is `strategies/`. Each platform strategy is a module exporting a `CleanResult`, selected by confidence-scored detection in `detect.ts` and orchestrated by `strip.ts`. To support a new documentation platform, add a strategy there and a detection signature in `detect.ts` — no other file needs to change. Everything else in the pipeline is platform-agnostic by design.

Fetch tiers are ordered in `fetch.ts` and are tried cheapest-first; a new acquisition method slots into that ladder.

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

## Architecture

```
docmirror.ts          CLI entry (Commander.js)
  ├── discover.ts     5-stage URL discovery + Firecrawl search (--filter)
  ├── fetch.ts        Content acquisition + local HTML tier + Jina rate limiter
  ├── detect.ts       Confidence-scored platform detection
  ├── strip.ts        Strategy orchestrator + quality gate
  │   └── strategies/ Generic + GitBook, Docusaurus, Sphinx, Mintlify, MkDocs
  ├── smart.ts        BM25 relevance pruning (--smart)
  ├── condense.ts     LLM compression + structural validators (--condense)
  │   └── prompts/    Condense system prompt (versioned)
  ├── validate.ts     Cleanliness, fidelity, coverage reports
  ├── compile.ts      Markdown assembly + TOC + token estimate
  ├── postcompile.ts  Cross-page dedup, heading normalisation, grouped TOC
  ├── flags.ts        Per-page quality flag detectors
  ├── types.ts        Shared type definitions
  ├── state.ts        run.json manifest for resumability
  └── evidence/       Measurement + A/B harnesses (see METHODOLOGY.md)
```

## License

MIT

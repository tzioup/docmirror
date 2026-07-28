# Evidence methodology

Everything in the README's evidence sections is produced by the scripts in this
directory. This file is the protocol: what is measured, how, what the numbers do
and do not support, and how to re-run any of it.

Two independent measurements live here. They answer different questions and are
deliberately never combined into a single headline figure.

| | What it measures | Cost to run | Needs an LLM |
|---|---|---|---|
| `measure.ts` | Corpus size, and what the same docs cost as raw HTML | Free | No |
| `ab/` | Whether an agent answers doc questions better with a local corpus | ~$1–2 | Yes |

---

## 1. Corpus size — `measure.ts`

### What it reports, and why it is split in two

**Front-door cost.** For each source, a deterministic sample of documentation
URLs is taken from the site's own `sitemap.xml` and fetched as raw HTML. The mean
HTML bytes per page is compared against the mirrored corpus's mean bytes per page
(corpus total ÷ documented page count). This is the figure that holds for every
source, and it is what a reader wants to know: what a documentation page costs
through the front door versus mirrored.

**Pipeline delta.** Bytes docmirror fetched versus bytes it emitted.

> **This is only a compression claim on the HTML strip path.** When a site
> publishes `/llms-full.txt`, docmirror takes a single-file fast path and performs
> **no stripping at all** — its own `run.json` records
> `"fidelity": "not applicable — single-file fast path, no stripping performed"`.
> Reporting a reduction percentage there would be a fabrication. `measure.ts`
> prints `n/a — fast path, no stripping` for those sources, and the README does
> the same. On that path the product is availability and latency, not compression.

Most sources take the fast path, so a single averaged "docmirror shrinks docs by
N%" number would be wrong for the majority of them. That is why there is no such
number anywhere in the README.

### Protocol

```bash
# 1. Mirror the sources. --condense is deliberately NOT passed: it is a second,
#    lossy variable, and the size claims must be about the core pipeline.
DOCMIRROR_OUTPUT=./runs bun docmirror.ts https://bun.sh/docs --name bun
DOCMIRROR_OUTPUT=./runs bun docmirror.ts https://hono.dev --name hono
DOCMIRROR_OUTPUT=./runs bun docmirror.ts https://vitest.dev --name vitest
# ...one per source

# 2. Measure.
bun evidence/measure.ts --runs ./runs --out evidence/results
```

Outputs `corpus-sizes.json` (raw) and `corpus-sizes.md` (the table the README
embeds). The HTML sample is an even spread across the sitemap, not a random draw,
so two runs over an unchanged site are comparable.

### Limits

- Site HTML changes, so absolute byte figures drift. The *ratio* is the durable
  part; re-run rather than trusting a stale number.
- `sitemap.xml` is treated as the site's page count. A site that omits pages from
  its sitemap will show a larger mean-markdown-bytes-per-page than reality.
- Token counts are the same ~4-chars-per-token estimate docmirror's own compile
  step uses. They are an estimate, not a tokenizer's output.

---

## 2. Front door vs cache — `ab/`

### The question

Does an agent answering documentation questions do better with a local docmirror
corpus than with live web access? "Better" is measured on four axes: correctness,
wall-clock, cost, and turns.

### Design

Two arms, same model, same questions, same grader. **Only the tool surface differs.**

| | Tools allowed | Tools denied | Working directory |
|---|---|---|---|
| `frontdoor` | `WebFetch`, `WebSearch` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | A directory with no corpus in it |
| `cache` | `Read`, `Grep`, `Glob` | `WebFetch`, `WebSearch`, `Bash`, `Edit`, `Write` | The corpus root |

The front-door arm runs from a directory containing no corpus, so a local read is
not merely denied by flag — there is nothing there to read.

**Model: Sonnet.** Not the largest model available. A frontier model's stronger
recall would mask the effect being measured, and Sonnet is closer to what a
cost-conscious agent loop actually runs.

### Question design — the part that decides whether the test means anything

The single largest threat to this experiment is a question set the model can
answer from pretraining. If it can, both arms score 100% and the comparison is
vacuous. Every question therefore targets a **specific documented default value,
flag name, or environment variable** — things that exist in the docs and that a
model is unlikely to recall reliably:

- Vitest's default `browser.api` port
- The default `browser.viewport` dimensions
- The build flag that disables `bunfig.toml` autoloading in a compiled executable
- The environment variable standalone Bun executables read for runtime flags

The set is in `ab/questions.json` and is **frozen and committed before any arm
runs**, so the "no fitting to results" claim is checkable from git history rather
than asserted.

### Grading

Deterministic. Each question carries an `all_of` list of regexes; an answer passes
only if every one matches, case-insensitively. **No model sits in the grading
path** — re-running `grade.ts` over the same raw records always produces the same
score. Keys are written to tolerate formatting variance: a viewport answer must
contain both `414` and `896`, in any layout, rather than one literal string.

### Telemetry

Read from the runner's JSON output, never self-reported by the model: token
counts, `total_cost_usd`, `duration_ms`, `num_turns`, and the count of web
fetches and searches actually performed.

### Local context is removed as a variable

Each arm is invoked with `--setting-sources ""` and runs in a directory with no
project instructions above it. Without this, a result would be partly a fact about
one machine's configuration rather than about the corpus. This is the same reason
the CONDENSE section recommends a sandboxed runner.

### Protocol

```bash
# 1. Build corpora in the layout the harness expects:
#      <corpora>/<name>/<name>.md
mkdir -p corpora/vitest && cp runs/vitest-docs-*/vitest-docs-compiled.md corpora/vitest/vitest.md

# 2. Run both arms.
bun evidence/ab/run-ab.ts --corpora ./corpora --out evidence/ab/runs

# 3. Grade.
bun evidence/ab/grade.ts evidence/ab/runs/raw-frontdoor+cache.json
```

`--arm frontdoor` or `--arm cache` runs one side alone.

### Reading the cost figures honestly

The first call in each arm writes a prompt cache for the system prompt and costs
roughly 3–4× a subsequent call; later calls read it. `grade.ts` reports
`calls_that_wrote_prompt_cache` alongside median and total cost so a 20-question
run does not look cheaper per question than a 2-question run for no real reason.
**Compare medians, not totals**, unless the run lengths match.

### Limits — read these before quoting a number

- **n = 1 per question per arm.** These are not repeated trials, so per-question
  outcomes carry no confidence interval. The aggregate direction is the signal;
  a single question flipping is not.
- **Network conditions affect the front-door arm only.** A slow or rate-limited
  fetch penalises one side. Re-run before treating a latency gap as settled.
- **The corpus is a snapshot.** If the live docs have changed since it was built,
  the cache arm can be confidently wrong where the front-door arm is right. That
  is a real property of caching, not a flaw in the harness — it is the cost side
  of the trade the README describes.
- **Question selection bias.** Questions were authored by reading the mirrored
  corpus, which guarantees the cache arm has the answer. They were drawn from
  canonical documentation pages that are equally present on the live site, and
  the front-door arm has search as well as fetch — but this is the assumption
  most worth attacking if you want to falsify the result.
- **Both arms may be wrong for different reasons.** A miss in the front-door arm
  can mean the model answered from memory without fetching; the `web_calls`
  column in the per-question output distinguishes that from a failed search.

---

## 3. Running this in CI

`measure.ts` is free, needs no credentials, and is the one to schedule. It
catches the regression that matters: a source whose corpus silently collapses
because its site changed shape.

The A/B costs money and needs the runner authenticated, so it belongs on a manual
trigger or a release gate, not on every push. Nothing about the harness assumes a
particular auth path — it shells out to whatever `claude` is on `PATH`.

## 4. Sandbox note

Where Bun's native `fetch` cannot reach the network — some sandboxes route egress
through a proxy Bun does not use, and every request fails with `ECONNRESET`
regardless of `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, or fetch's own `proxy:`
option — preload the curl-backed shim:

```bash
bun --preload ./evidence/lib/curl-fetch-shim.ts docmirror.ts <url>
```

It replaces `globalThis.fetch` with a curl subprocess and touches no docmirror
source. It is **not needed** on an ordinary machine or in GitHub Actions; check
with a one-line fetch before reaching for it. Its fidelity boundary is documented
at the top of the file — it is enough to mirror doc sites, not a general polyfill.

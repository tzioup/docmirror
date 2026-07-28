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

**Strip delta.** Bytes docmirror fetched versus bytes left after noise-stripping,
measured over the **same page set** on both sides.

> Comparing fetched bytes against the final *compiled* file is wrong on any run
> that used `--smart`, because the compiled file is post-pruning: astro dropped
> 1928 pages to 40, which computes as "96.7% reduction" and is page-pruning, not
> compression. `clean/` holds one stripped file per fetched page, so raw → clean
> isolates stripping.

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
- Mean mirrored bytes per page is computed differently by path, and it has to
  be: on the strip path from `clean/` (one file per page), on the fast path from
  the compiled file over the site's page count, because a single `llms-full.txt`
  covers the whole site and has no per-page split. Using the site's page count
  on a `--smart` run divides a 40-page corpus by a 417-page site and overstates
  the ratio by roughly 10×.
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

Three arms, same model, same questions, same grader. **Only the tool surface differs.**

| | Tools allowed | Tools denied | Working directory |
|---|---|---|---|
| `frontdoor` | `WebFetch`, `WebSearch` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | A directory with no corpus in it |
| `cache` | `Read`, `Grep`, `Glob` | `WebFetch`, `WebSearch`, `Bash`, `Edit`, `Write` | The corpus root |
| `memory` | none | everything | A directory with no corpus in it |

The front-door arm runs from a directory containing no corpus, so a local read is
not merely denied by flag — there is nothing there to read.

**The `memory` arm is the control, and it is what makes the other two
interpretable.** Two arms tying at 10/10 could mean both sources worked, or that
neither was ever consulted and the model answered from pretraining both times.
The control separates those: it scored **0/10**, so the question set is not
answerable from prior knowledge and both sourced arms were genuinely reading
their source. Run it whenever the question set changes.

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

**One key defect was found and corrected after the first run, and it is recorded
in `questions.json` under `key_corrections`.** Numeric patterns were written
`\bN\b`, and `\b` does not match between `0` and `m`, so `\b50\b` failed
against a correct answer written `50ms`. This was not a threshold someone wanted
to move: it passed the cache arm's `` `50` ms `` and failed the front-door arm's
`**50ms**`, so the key was silently favouring one arm's phrasing. The fix is
symmetric, both arms were re-graded with the identical corrected key, and both
the original and corrected scores are reported. Changing a key after seeing
results is legitimate only under those three conditions — the key is
demonstrably broken, the fix is applied to every arm, and the change is
disclosed.

### Telemetry

Read from the runner's JSON output, never self-reported by the model: token
counts, `total_cost_usd`, `duration_ms`, and `num_turns`.

> **`web_fetches` / `web_searches` are recorded but are not a usable signal
> here.** They come from `usage.server_tool_use`, which counts *server-side* web
> tools. The runner's `WebFetch`/`WebSearch` are client-side, so those fields
> read 0 even on an arm that fetched the web on every question. Use `num_turns`
> as the tool-activity proxy, and the presence of cited source URLs in the answer
> text as the confirmation that fetching happened.

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

# 2. Run all three arms.
bun evidence/ab/run-ab.ts --corpora ./corpora --out evidence/ab/runs
bun evidence/ab/run-ab.ts --corpora ./corpora --out evidence/ab/runs --arm memory

# 3. Grade them together.
bun evidence/ab/grade.ts evidence/ab/runs/raw-*.json
```

`--arm frontdoor`, `--arm cache` or `--arm memory` runs one side alone.

### Reading the cost figures honestly

The first call in each arm writes a prompt cache for the system prompt and costs
roughly 3–4× a subsequent call; later calls read it. `grade.ts` reports
`calls_that_wrote_prompt_cache` alongside median and total cost so a 20-question
run does not look cheaper per question than a 2-question run for no real reason.
**Compare medians, not totals**, unless the run lengths match.

### Limits — read these before quoting a number

- **Both arms scored 10/10, so this run says nothing about accuracy.** The
  finding is latency and cost. A question set hard enough to separate the arms
  on correctness would be a different experiment.
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

## 4. Where to run this: sandbox or workstation

Both halves were produced in an ephemeral cloud sandbox, and the split is worth
knowing before you re-run either.

**The A/B is *better* in a sandbox, and not as a convenience.** The result has to
be a fact about the corpus, not about one machine's configuration — and a
developer workstation is full of exactly the confounders that would make it the
latter: project instruction files above the working directory, user settings, a
populated shell environment. The sandbox has none of that above the run, which is
the same argument the condense section makes for a sandboxed runner. Both arms
also pass `--setting-sources ""`. Nothing about the measurement wants a laptop.

**The size measurement is the half that carries a caveat**, and it is about the
network rather than the machine:

- Byte figures are network-independent — the same page yields the same bytes
  anywhere. These transfer.
- Wall-clock figures do not. This sandbox routes egress through a proxy, and one
  source's crawl was slow enough to abandon. Never quote a mirroring *duration*
  measured here as what a user should expect.
- One environment-specific defect is worth naming so it is not mistaken for a
  tool bug: **Bun's `fetch` cannot reach the network here at all**, failing with
  `ECONNRESET` against every host regardless of `HTTPS_PROXY`,
  `NODE_EXTRA_CA_CERTS`, or fetch's own `proxy:` option, while `curl` works. That
  is a property of this sandbox, not of docmirror.

**What genuinely needs a real machine:** nothing in either harness. The one thing
neither can establish from here is how the tool behaves on a residential
connection against rate-limited doc hosts — that is a latency and politeness
question, and it wants a normal network rather than a particular computer.

### Running under a proxy Bun cannot use



Preload the curl-backed shim:

```bash
bun --preload ./evidence/lib/curl-fetch-shim.ts docmirror.ts <url>
```

It replaces `globalThis.fetch` with a curl subprocess and touches no docmirror
source. It is **not needed** on an ordinary machine or in GitHub Actions; check
with a one-line fetch before reaching for it. Its fidelity boundary is documented
at the top of the file — it is enough to mirror doc sites, not a general polyfill.

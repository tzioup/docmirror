# Fabric patterns

Prompts from this repo, packaged in [Fabric](https://github.com/danielmiessler/fabric)'s
pattern layout (`<pattern_name>/system.md`) so they can be used with `fabric -p`
or submitted upstream.

**Nothing here is required to use DocMirror.** These are shared because the
prompts were useful to us and may be a useful starting point for someone else.

## Patterns

| Pattern | What it does | Where it is used in this repo |
|---|---|---|
| `condense_documentation_page` | Tightens one page of product documentation, preserving every code block, heading, and technical claim while removing filler prose. | The `--condense` step, one page at a time |

## Use

```bash
# From this directory
cp -r condense_documentation_page ~/.config/fabric/patterns/

cat some-doc-page.md | fabric -p condense_documentation_page
```

## Before you rely on this

The same caveats that apply to `--condense` in the [main README](../../README.md#condense)
apply here, and they are the point rather than boilerplate:

- **It was evaluated, and the evaluation is a dated observation, not a
  guarantee.** Measured with a 20-case structural eval, a GPT-4o judge scoring
  fidelity and hallucination, a full 194-page corpus run, and an independent
  cross-vendor code audit. On the Haiku family it passed 20/20 structural cases,
  scored 4.90/5 on judged fidelity, and averaged ~30% reduction; across the full
  corpus, 90% of pages passed with 23.4% average reduction and every failure fell
  back to the uncondensed page rather than shipping broken output.
- **Prompt version and model version are independent variables.** This is
  prompt v2.0.0. The scores above were measured against a model family, not a
  pinned snapshot. Neither axis alone explains a result.
- **Models change under a fixed name, silently.** Providers revise serving
  behaviour without changing the model id, so the same prompt can score
  differently months later with nothing on your side having moved, and no
  notification.
- **Your own context is a variable.** System prompts, project instructions and
  local config all shape the output. Running the prompt in a sandboxed runner
  with no user config above it is the cleanest way to remove that whole class.
- **Structural validation is not semantic validation.** DocMirror pairs this
  prompt with three deterministic checks — code-block count, heading count, and
  a word-count ceiling — and even so, a condensed page that drops a caveat or
  inverts a negation passes all three. This is lossy compression.

**Run your own eval with a QC step before trusting any prompt × model pairing
for anything with stakes.** If you want a starting point, the harness shape we
used is described in [`evidence/METHODOLOGY.md`](../../evidence/METHODOLOGY.md).

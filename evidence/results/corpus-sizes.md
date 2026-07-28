### Front-door cost vs mirrored corpus

| Source | Doc pages | Mean HTML page | Mean mirrored page | Ratio | Corpus total | Est. tokens |
|---|---:|---:|---:|---:|---:|---:|
| astro | 417 | 182 KB | 7 KB | 24.4× | 500 KB ¹ | 89,288 ¹ |
| bun | 315 | 412 KB | 6 KB | 66.1× | 1.9 MB | 324,443 |
| fastapi | 151 | 216 KB | 20 KB | 10.6× | 1.9 MB ¹ | 306,632 ¹ |
| hono | 86 | 85 KB | 4 KB | 20.5× | 356 KB | 76,974 |
| vitest | 191 | 90 KB | 6 KB | 15× | 1.1 MB | 240,299 |

¹ Run with `--smart … --top N`, so **Corpus total** and **Est. tokens** describe the kept subset, not the whole site — astro kept 40 of 1928 stripped pages; fastapi kept 40 of 145 stripped pages. Every other column, including the ratio, is measured over the full page set.

### Pipeline delta (bytes fetched → bytes emitted)

| Source | Discovery | Pages stripped | Raw | Stripped | Reduction |
|---|---|---:|---:|---:|---:|
| astro | `sitemap` | 1928 | 14.7 MB | 14.1 MB | 4.1% |
| bun | `llms-full-txt` | — | 1.9 MB | 1.9 MB | n/a — fast path, no stripping |
| fastapi | `sitemap` | 145 | 2.9 MB | 2.9 MB | 1.5% |
| hono | `llms-full-txt` | — | 356 KB | 356 KB | n/a — fast path, no stripping |
| vitest | `llms-full-txt` | — | 1.1 MB | 1.1 MB | n/a — fast path, no stripping |

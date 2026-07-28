### Front-door cost vs mirrored corpus

| Source | Doc pages | Mean HTML page | Mean mirrored page | Ratio | Corpus total | Est. tokens |
|---|---:|---:|---:|---:|---:|---:|
| astro | 417 | 182 KB | 7 KB | 24.4× | 500 KB | 128,057 |
| bun | 315 | 400 KB | 6 KB | 64.2× | 1.9 MB | 502,437 |
| fastapi | 151 | 216 KB | 20 KB | 10.6× | 1.9 MB | 505,461 |
| hono | 86 | 85 KB | 4 KB | 20.5× | 356 KB | 91,202 |
| vitest | 191 | 90 KB | 6 KB | 15× | 1.1 MB | 294,290 |

### Pipeline delta (bytes fetched → bytes emitted)

| Source | Discovery | Pages stripped | Raw | Stripped | Reduction |
|---|---|---:|---:|---:|---:|
| astro | `sitemap` | 1928 | 14.7 MB | 14.1 MB | 4.1% |
| bun | `llms-full-txt` | — | 1.9 MB | 1.9 MB | n/a — fast path, no stripping |
| fastapi | `sitemap` | 145 | 2.9 MB | 2.9 MB | 1.5% |
| hono | `llms-full-txt` | — | 356 KB | 356 KB | n/a — fast path, no stripping |
| vitest | `llms-full-txt` | — | 1.1 MB | 1.1 MB | n/a — fast path, no stripping |

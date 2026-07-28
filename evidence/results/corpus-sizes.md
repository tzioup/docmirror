### Front-door cost vs mirrored corpus

| Source | Doc pages | Mean HTML page | Mean mirrored page | Ratio | Corpus total | Est. tokens |
|---|---:|---:|---:|---:|---:|---:|
| bun | 315 | 400 KB | 6 KB | 64.2× | 1.9 MB | 502,437 |
| fastapi | 151 | 216 KB | 13 KB | 16.5× | 1.9 MB | 505,461 |
| hono | 86 | 85 KB | 4 KB | 20.5× | 356 KB | 91,202 |
| vitest | 191 | 90 KB | 6 KB | 15× | 1.1 MB | 294,290 |

### Pipeline delta (bytes fetched → bytes emitted)

| Source | Discovery | Fetched | Emitted | Reduction |
|---|---|---:|---:|---:|
| bun | `llms-full-txt` | 1.9 MB | 1.9 MB | n/a — fast path, no stripping |
| fastapi | `sitemap` | 2.9 MB | 1.9 MB | 34% |
| hono | `llms-full-txt` | 356 KB | 356 KB | n/a — fast path, no stripping |
| vitest | `llms-full-txt` | 1.1 MB | 1.1 MB | n/a — fast path, no stripping |

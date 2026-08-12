/**
 * curl-backed `fetch` shim.
 *
 * Some sandboxed environments (notably Claude Code's cloud sandbox) route all
 * egress through a local CONNECT proxy that Bun's native `fetch` cannot use —
 * every request dies with ECONNRESET regardless of HTTPS_PROXY, NODE_EXTRA_CA_CERTS
 * or fetch's own `proxy:` option. `curl` honours the proxy correctly.
 *
 * Loading this file with `bun --preload` replaces `globalThis.fetch` with a
 * curl subprocess of equivalent behaviour, so docmirror runs unmodified.
 *
 * It is a NO-OP where native fetch already works, so check before reaching for it:
 *
 *   bun -e 'fetch("https://bun.sh/docs").then(r => console.log(r.status)).catch(e => console.log("BROKEN:", e.message))'
 *
 * A status code means you do not need this file. Nothing in the docmirror source
 * knows it exists.
 *
 * Fidelity boundary — this shim is good enough to mirror doc sites, not a
 * general fetch polyfill. It does not implement streaming bodies, ReadableStream
 * request bodies, cookies, keep-alive reuse, or `redirect: "manual"`.
 */

const DEFAULT_TIMEOUT_SEC = 120;
const nativeFetch = globalThis.fetch;

function headersToCurlArgs(headers: HeadersInit | undefined): string[] {
  if (!headers) return [];
  const out: string[] = [];
  new Headers(headers).forEach((value, key) => {
    out.push("-H", `${key}: ${value}`);
  });
  return out;
}

/** curl -D writes one header block per redirect hop; the last one is the response we got. */
function parseFinalHeaderBlock(raw: string): { status: number; statusText: string; headers: Headers } {
  const blocks = raw
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const last = blocks[blocks.length - 1] ?? "";
  const lines = last.split(/\r?\n/);
  const statusLine = lines.shift() ?? "HTTP/1.1 000";
  const match = statusLine.match(/^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/);
  const status = match ? Number(match[1]) : 0;
  const statusText = match ? (match[2] ?? "").trim() : "";

  const headers = new Headers();
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    try {
      headers.append(name, value);
    } catch {
      // Skip header names curl emitted that the Headers class rejects.
    }
  }
  return { status, statusText, headers };
}

/** 1xx/204/205/304 must be constructed with a null body or Response throws. */
function bodyAllowed(status: number): boolean {
  return !(status < 200 || status === 204 || status === 205 || status === 304);
}

export function installCurlFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();

    const headerInit: HeadersInit | undefined = init?.headers ?? (request ? request.headers : undefined);

    const bodyFile = `/tmp/curlshim-${crypto.randomUUID()}.body`;
    const headFile = `/tmp/curlshim-${crypto.randomUUID()}.head`;

    const args = [
      "curl",
      "--silent",
      "--show-error",
      "--location",
      "--compressed",
      "--max-time",
      String(DEFAULT_TIMEOUT_SEC),
      "--dump-header",
      headFile,
      "--output",
      bodyFile,
      "-X",
      method,
      ...headersToCurlArgs(headerInit),
    ];

    let bodyText: string | undefined;
    if (init?.body != null) {
      bodyText = typeof init.body === "string" ? init.body : String(init.body);
      args.push("--data-binary", "@-");
    }

    args.push(url);

    const proc = Bun.spawn(args, {
      stdin: bodyText != null ? new Blob([bodyText]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const signal = init?.signal ?? request?.signal ?? null;
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const exitCode = await proc.exited;

      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new TypeError(`fetch failed (curl exit ${exitCode}): ${stderr.trim() || url}`);
      }

      const headRaw = await Bun.file(headFile).text().catch(() => "");
      const { status, statusText, headers } = parseFinalHeaderBlock(headRaw);
      const bytes = await Bun.file(bodyFile).arrayBuffer().catch(() => new ArrayBuffer(0));

      // Body is already decompressed by --compressed; drop the stale framing headers
      // so downstream code does not try to decode it twice.
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");

      return new Response(bodyAllowed(status) ? bytes : null, { status, statusText, headers });
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await Promise.all([
        Bun.file(bodyFile).delete().catch(() => {}),
        Bun.file(headFile).delete().catch(() => {}),
      ]);
    }
  }) as typeof fetch;
}

export function restoreNativeFetch(): void {
  globalThis.fetch = nativeFetch;
}

// `bun --preload` executes the module body.
installCurlFetch();

/**
 * Small fetch wrapper: per-request timeout, one retry on 429/5xx with backoff
 * that honors Retry-After. Throws {@link HttpError} on non-OK responses so
 * source adapters can distinguish network/HTTP failures from empty results.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT =
  "startup-enrich/0.1 (+https://github.com/; free-tier company enrichment)";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body; sets Content-Type automatically. */
  json?: unknown;
  timeoutMs?: number;
  /** Number of retries on 429/5xx (default 1). */
  retries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 15000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 15000));
  }
  return Math.min(500 * 2 ** attempt, 4000); // exponential backoff
}

async function rawFetch(url: string, opts: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": USER_AGENT,
      ...opts.headers,
    };
    let body: string | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["content-type"] = "application/json";
    }
    return await fetch(url, {
      method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"),
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch and parse JSON, with timeout + retry. Throws HttpError on failure. */
export async function fetchJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await rawFetch(url, opts);
      if (res.ok) {
        return (await res.json()) as T;
      }
      // Retry transient statuses; fail fast on 4xx (except 429).
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new HttpError(
        `HTTP ${res.status} for ${url}${text ? `: ${text.slice(0, 200)}` : ""}`,
        res.status,
        url,
      );
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err;
      // Network error / abort: retry if attempts remain.
      if (attempt < retries) {
        await sleep(Math.min(500 * 2 ** attempt, 4000));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Request failed: ${url}`);
}

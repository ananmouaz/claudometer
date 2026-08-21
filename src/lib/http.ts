// Shared plumbing for the local proxy routes (claude.ai + chatgpt.com).

/**
 * The upstreams (and, for claude.ai, its Cloudflare edge) occasionally stall.
 * Cap each request so a hung connection surfaces as a clean error instead of
 * leaving the proxy — and the client waiting on it — hanging until the platform
 * gives up.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 15_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

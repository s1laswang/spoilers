/**
 * A public URL fronts a paid key: each IP gets a handful of live (uncached)
 * simulations per window, then falls back to cached or fit-only results.
 */
const WINDOW_MS = 10 * 60_000;
const LIVE_PER_WINDOW = 20;
const hits = new Map<string, { n: number; reset: number }>();

export function allowLive(req: Request): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) {
    hits.set(ip, { n: 1, reset: now + WINDOW_MS });
    return true;
  }
  h.n++;
  return h.n <= LIVE_PER_WINDOW;
}

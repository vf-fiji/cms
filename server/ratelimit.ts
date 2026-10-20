import type { Request, Response, NextFunction } from "express";
import { HttpError } from "./auth";

// Fixed-window, in-memory rate limits. Good enough for a single Reef process; put a
// shared limiter (or the reverse proxy's) in front if you run several instances.
// Keys use req.ip, so set REEF_TRUST_PROXY correctly behind a proxy or every visitor
// shares the proxy's address.

interface Window {
  count: number;
  resetAt: number;
}

export interface Limiter {
  /** Counts one hit. Returns seconds to wait when over the limit, otherwise 0. */
  hit(key: string): number;
  reset(): void;
  readonly max: number;
  readonly windowMs: number;
}

const stores: Map<string, Window>[] = [];

export function createLimiter(max: number, windowMs: number): Limiter {
  const hits = new Map<string, Window>();
  const limiter: Limiter = {
    max,
    windowMs,
    hit(key) {
      if (max <= 0) return 0; // 0 turns the limit off
      const t = Date.now();
      let w = hits.get(key);
      if (!w || w.resetAt <= t) {
        if (hits.size >= 50_000) sweep(hits, t);
        w = { count: 0, resetAt: t + windowMs };
        hits.set(key, w);
      }
      w.count++;
      return w.count > max ? Math.max(1, Math.ceil((w.resetAt - t) / 1000)) : 0;
    },
    reset: () => hits.clear(),
  };
  stores.push(hits);
  return limiter;
}

function sweep(hits: Map<string, Window>, t: number) {
  for (const [k, w] of hits) if (w.resetAt <= t) hits.delete(k);
  if (hits.size >= 50_000) hits.clear(); // under attack from many addresses: start over rather than grow forever
}

setInterval(() => {
  const t = Date.now();
  for (const hits of stores) for (const [k, w] of hits) if (w.resetAt <= t) hits.delete(k);
}, 60_000).unref();

/** Reads a per-minute limit from the environment, e.g. REEF_RATE_LIMIT_FORMS=10. */
export function envLimit(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface RateLimitOptions {
  max: number;
  windowMs: number;
  /** Groups requests; defaults to the client IP. */
  key?: (req: Request) => string;
  message?: string;
  /** Custom response for over-limit requests (e.g. HTML for plain form posts). */
  onLimited?: (req: Request, res: Response, retryAfter: number, message: string) => void;
}

export function rateLimit(opts: RateLimitOptions) {
  const limiter = createLimiter(opts.max, opts.windowMs);
  const message = opts.message ?? "Too many requests. Please wait a moment and try again.";
  return (req: Request, res: Response, next: NextFunction) => {
    if (limiter.max <= 0) return next();
    const retryAfter = limiter.hit(opts.key ? opts.key(req) : (req.ip ?? "unknown"));
    if (!retryAfter) return next();
    res.setHeader("Retry-After", String(retryAfter));
    if (opts.onLimited) return opts.onLimited(req, res, retryAfter, message);
    next(new HttpError(429, message));
  };
}

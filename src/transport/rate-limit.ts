import type { NextFunction, Request, Response } from "express";
import { config } from "../shared/config.js";
import { logger } from "../shared/logger.js";

/**
 * Fixed-window limiter, per credential and per IP.
 *
 * This is not the quota. The quota protects the business — how many heatmaps a
 * plan includes. This protects the server: a client stuck in a retry loop, or
 * someone enumerating keys, should not be able to saturate it or run up the
 * bill on the services behind it.
 *
 * Both dimensions are needed. Per key alone lets one attacker rotate keys; per
 * IP alone punishes everyone behind a shared NAT.
 */
export function rateLimiter() {
  const windows = new Map<string, { count: number; resetAt: number }>();

  // Keeps the map from growing without bound on a long-lived process.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  }, config.RATE_LIMIT_WINDOW_MS);
  sweep.unref();

  const hit = (key: string, max: number): boolean => {
    const now = Date.now();
    const window = windows.get(key);

    if (!window || window.resetAt <= now) {
      windows.set(key, {
        count: 1,
        resetAt: now + config.RATE_LIMIT_WINDOW_MS,
      });
      return true;
    }

    window.count += 1;
    return window.count <= max;
  };

  return (request: Request, response: Response, next: NextFunction): void => {
    const ip = request.ip ?? "unknown";
    // The credential is hashed into the bucket key, never stored or logged.
    const credential = request.headers.authorization ?? "anonymous";
    const keyBucket = `k:${hashish(credential)}`;
    const ipBucket = `i:${ip}`;

    const allowed =
      hit(keyBucket, config.RATE_LIMIT_MAX_PER_KEY) && hit(ipBucket, config.RATE_LIMIT_MAX_PER_IP);

    if (!allowed) {
      logger.warn("Rate limit hit", { ip });
      response
        .status(429)
        .set("Retry-After", String(Math.ceil(config.RATE_LIMIT_WINDOW_MS / 1000)))
        .json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Too many requests. Slow down and try again shortly.",
          },
          id: null,
        });
      return;
    }

    next();
  };
}

/**
 * Cheap non-cryptographic digest, enough to bucket a credential without keeping
 * it in memory in the clear.
 */
function hashish(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return String(hash);
}

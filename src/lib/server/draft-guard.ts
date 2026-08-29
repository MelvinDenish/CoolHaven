/**
 * Rate limiting, budget ceiling and result caching for the draft-region
 * endpoints.
 *
 * WHY THIS EXISTS
 *
 * /api/admin/refresh-tile spends real credits and has no authentication, and
 * that has been safe for one reason only: it can address nothing but the twelve
 * tiles declared in REGIONS. Bounded set, bounded spend. The moment a user can
 * draw their own box that bound disappears, so the draft endpoints need an
 * explicit one.
 *
 * WHAT IS HONESTLY WEAK ABOUT IT
 *
 * All state here is module scope, which on Vercel means per warm instance. Two
 * concurrent instances have two independent counters, and a cold start resets
 * both. So the daily ceiling is a ceiling PER INSTANCE, not globally, and this
 * is a deployment-shaped mitigation rather than a hard guarantee.
 *
 * That is a deliberate trade, not an oversight: the project has no datastore,
 * and adding one to hold a rate-limit counter would be a bigger change than the
 * feature it protects. If drafts see real use, swap the maps below for Vercel
 * KV behind the same function signatures - no caller changes.
 *
 * Every limit is env-configurable so a deployment can tighten it without a code
 * change:
 *   DRAFT_DAILY_CALL_LIMIT   live heatmap submissions per instance per day
 *   DRAFT_IP_CALLS_PER_HOUR  live heatmap submissions per IP per hour
 */
import type { HeatGrid } from '../types';

const DAILY_CALL_LIMIT = intFromEnv('DRAFT_DAILY_CALL_LIMIT', 40);
const IP_CALLS_PER_HOUR = intFromEnv('DRAFT_IP_CALLS_PER_HOUR', 6);

/** Derived data is worth keeping for a while; a heat field is a day's worth. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Bounded so a long-lived instance cannot grow without limit. */
const CACHE_MAX_ENTRIES = 40;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const gridCache = new Map<string, CacheEntry<HeatGrid>>();
const contextCache = new Map<string, CacheEntry<unknown>>();
const ipHits = new Map<string, number[]>();

let dailyCount = 0;
let dailyResetAt = 0;

export class DraftLimitError extends Error {
  readonly status: number;
  constructor(message: string, status = 429) {
    super(message);
    this.name = 'DraftLimitError';
    this.status = status;
  }
}

/**
 * Charge one live API call to the caller's budget, or refuse.
 *
 * Called immediately before a submission, never after: a call that was refused
 * must not have been made, and a call that failed still consumed a slot at the
 * far end.
 */
export function chargeLiveCall(ip: string): void {
  const now = Date.now();

  if (now > dailyResetAt) {
    dailyCount = 0;
    dailyResetAt = now + 24 * 60 * 60 * 1000;
  }
  if (dailyCount >= DAILY_CALL_LIMIT) {
    throw new DraftLimitError(
      `This deployment has spent its daily budget of ${DAILY_CALL_LIMIT} live ` +
        'temperature requests for drafted areas. The curated cities are unaffected - ' +
        'they run from a committed snapshot and make no live calls at all.',
      503,
    );
  }

  const hourAgo = now - 60 * 60 * 1000;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > hourAgo);
  if (hits.length >= IP_CALLS_PER_HOUR) {
    throw new DraftLimitError(
      `That is ${IP_CALLS_PER_HOUR} live temperature requests from this address in an ` +
        'hour, which is the limit. Every request costs a credit against a shared key, ' +
        'so drafting is rate-limited rather than free.',
    );
  }

  hits.push(now);
  ipHits.set(ip, hits);
  dailyCount += 1;

  // Opportunistic sweep; there is no timer to do it and no need for one.
  if (ipHits.size > 500) {
    for (const [key, times] of ipHits) {
      if (times.every((t) => t <= hourAgo)) ipHits.delete(key);
    }
  }
}

/** Give a charge back when the call never actually reached the API. */
export function refundLiveCall(ip: string): void {
  dailyCount = Math.max(0, dailyCount - 1);
  const hits = ipHits.get(ip);
  if (hits?.length) hits.pop();
}

export function cachedGrid(key: string): HeatGrid | null {
  return readCache(gridCache, key);
}

export function cacheGrid(key: string, grid: HeatGrid): void {
  writeCache(gridCache, key, grid);
}

export function cachedContext<T>(key: string): T | null {
  return readCache(contextCache, key) as T | null;
}

export function cacheContext<T>(key: string, value: T): void {
  writeCache(contextCache, key, value);
}

/**
 * Best-effort client address.
 *
 * Behind Vercel this is the real client; behind nothing it is undefined and
 * every caller shares one bucket, which fails closed rather than open.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** What the limits currently are, so a panel can say so before spending. */
export function draftBudgetStatus() {
  const now = Date.now();
  const remaining =
    now > dailyResetAt ? DAILY_CALL_LIMIT : Math.max(0, DAILY_CALL_LIMIT - dailyCount);
  return {
    dailyLimit: DAILY_CALL_LIMIT,
    dailyRemaining: remaining,
    perIpHourlyLimit: IP_CALLS_PER_HOUR,
    note:
      'Counted per server instance, so this is a floor rather than a global ' +
      'guarantee. See the note at the top of src/lib/server/draft-guard.ts.',
  };
}

function readCache<T>(store: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return null;
  }
  // Refresh recency for the eviction order below.
  store.delete(key);
  store.set(key, hit);
  return hit.value;
}

function writeCache<T>(store: Map<string, CacheEntry<T>>, key: string, value: T): void {
  store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (store.size > CACHE_MAX_ENTRIES) {
    // Map preserves insertion order and reads re-insert, so the first key is
    // the least recently used.
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * FortyGuard API keys, resolved from the environment as an ordered pool.
 *
 * There was one key, read inline as `process.env.FORTYGUARD_API_KEY` in seven
 * places. Three things made that worth centralising:
 *
 *   1. A key can be rate-limited or exhausted mid-ingest. With one key that is
 *      the end of the run; with a pool the next one takes over.
 *   2. The interactive "fetch this tile" button and the batch ingest scripts
 *      should not compete for the same budget - a demo that fails because a
 *      backfill drained the quota is the worst possible moment to find out.
 *   3. The API's capabilities appear to be key-scoped rather than
 *      service-scoped: filter_type 1/2/4 return HTTP 500 and the forecast
 *      horizon stops at about one day on the current key. Whether that holds
 *      for ALL keys is an empirical question, and answering it needs more than
 *      one key to compare. See scripts/probe-keys.ts.
 *
 * FORTYGUARD_API_KEY_2 and _3 are OPTIONAL and absent today. Everything here
 * degrades to exactly the previous single-key behaviour when they are missing,
 * so no caller has to wait for them to be issued.
 */

/** Env var names, in the order they are preferred. */
export const KEY_VARS = [
  'FORTYGUARD_API_KEY',
  'FORTYGUARD_API_KEY_2',
  'FORTYGUARD_API_KEY_3',
] as const;

export interface ApiKey {
  /** The env var it came from - used in logs, so a failure can name a key. */
  name: string;
  value: string;
}

/**
 * Every key present in the environment, in preference order.
 *
 * The `name` is what belongs in output; no log line in this project prints key
 * material, not even a prefix of it.
 */
export function loadKeys(env: NodeJS.ProcessEnv = process.env): ApiKey[] {
  const out: ApiKey[] = [];
  for (const name of KEY_VARS) {
    const value = env[name]?.trim();
    if (value) out.push({ name, value });
  }
  return out;
}

/** The first key, or null. Equivalent to the old single-key read. */
export function primaryKey(env: NodeJS.ProcessEnv = process.env): ApiKey | null {
  return loadKeys(env)[0] ?? null;
}

/**
 * The key an interactive request should use.
 *
 * Prefers the LAST key in the pool, so ad-hoc traffic from the refresh button
 * and the draft-region tool lands on a different quota from the batch scripts,
 * which start at the first. With one key configured both resolve to it and the
 * behaviour is identical to before.
 */
export function interactiveKey(env: NodeJS.ProcessEnv = process.env): ApiKey | null {
  const keys = loadKeys(env);
  return keys.length === 0 ? null : keys[keys.length - 1];
}

/** Summary for startup logs. Names only, never values. */
export function describeKeys(env: NodeJS.ProcessEnv = process.env): string {
  const keys = loadKeys(env);
  if (keys.length === 0) return 'no FortyGuard keys configured';
  return `${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys
    .map((k) => k.name)
    .join(', ')}`;
}

/**
 * Run `fn` against each key in turn until one succeeds.
 *
 * Used by the batch scripts so a quota failure on key 1 continues on key 2
 * rather than ending the run. `shouldRetry` separates "this key is spent" from
 * "this request is wrong" - retrying a 400 against three keys is three times
 * the same wrong answer.
 */
export async function withKeyRotation<T>(
  keys: ApiKey[],
  fn: (key: ApiKey) => Promise<T>,
  opts: {
    shouldRetry?: (err: unknown) => boolean;
    onRotate?: (from: ApiKey, to: ApiKey, err: unknown) => void;
  } = {},
): Promise<T> {
  if (keys.length === 0) throw new Error('No FortyGuard API keys configured.');
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let lastErr: unknown;
  for (let i = 0; i < keys.length; i++) {
    try {
      return await fn(keys[i]);
    } catch (err) {
      lastErr = err;
      const next = keys[i + 1];
      if (!next || !shouldRetry(err)) throw err;
      opts.onRotate?.(keys[i], next, err);
    }
  }
  throw lastErr;
}

/**
 * Rotate on quota, auth and transport failures only.
 *
 * A 500 from filter_type 1 is deliberately NOT retried: it is the observed
 * behaviour of this API for unsupported filter types, and spending two more
 * keys to receive it twice more establishes nothing. probe-keys.ts asks that
 * question deliberately, with its own policy.
 */
function defaultShouldRetry(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403 || status === 429) return true;
  if (status === undefined) return true; // network / timeout
  return false;
}

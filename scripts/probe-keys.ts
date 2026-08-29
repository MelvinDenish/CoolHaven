/**
 * Ask each configured key what it is actually allowed to do.
 *
 * Two limits shape this whole product, and both are currently assumptions
 * drawn from a sample of one key:
 *
 *   1. Only `filter_type: 3` (forecast) is served. Types 1, 2 and 4 pass
 *      validation and then return HTTP 500. The Planner is DESIGNED to read
 *      historic data and is collapsed to forecast because of this - so if
 *      historic works on any key, a feature that is already written switches
 *      on rather than having to be built.
 *
 *   2. The forecast horizon stops at about one day. Snapshot+2 returns 500 for
 *      every tile tried, which is why the day selector usually offers one
 *      option.
 *
 * Neither is documented. Both might be scoped to the KEY rather than to the
 * SERVICE, and that is a question you cannot answer with one key. This probe
 * asks every configured key the same small set of questions and prints a
 * matrix showing which.
 *
 * It is deliberately cheap and deliberately explicit:
 *   - the smallest legal AOI it can construct, not a real tile
 *   - one submission per (key, question), never in a loop
 *   - it SUBMITS and reads the immediate response rather than polling to
 *     completion: the question is "is this accepted", not "what is the
 *     temperature", and a request destined to 500 does so at submit time
 *
 * Usage:
 *   npm run probe:keys
 *   npm run probe:keys -- --poll     also drive one accepted job to completion
 *
 * Nothing here touches the snapshot cache, and no key material is printed or
 * persisted - only the env var name each result came from.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { FortyGuardClient } from '../src/lib/fortyguard';
import { loadKeys, describeKeys, type ApiKey } from '../src/lib/keys';
import { addDays, arizonaToday } from '../src/lib/config';
import { getRegion } from '../src/lib/regions';

/** filter_type values worth asking about, and what each is meant to mean. */
const FILTER_TYPES: Array<{ ft: number; label: string }> = [
  { ft: 1, label: 'historic' },
  { ft: 2, label: 'type 2' },
  { ft: 3, label: 'forecast (known good)' },
  { ft: 4, label: 'type 4' },
];

/** Days ahead of today to try, to find where the horizon actually stops. */
const HORIZON_OFFSETS = [0, 1, 2, 3, 5, 7];

interface Attempt {
  ok: boolean;
  status: number | null;
  activityId: string | null;
  message: string | null;
  ms: number;
}

interface KeyReport {
  name: string;
  filterTypes: Array<{ filterType: number; label: string } & Attempt>;
  horizon: Array<{ dayOffset: number; date: string } & Attempt>;
}

async function main() {
  const poll = process.argv.includes('--poll');
  const keys = loadKeys();

  console.log(`\n[probe] ${describeKeys()}`);
  if (keys.length === 0) {
    console.error(
      '\n[probe] No keys configured. Set FORTYGUARD_API_KEY (and optionally\n' +
        '        FORTYGUARD_API_KEY_2, FORTYGUARD_API_KEY_3) in .env.local.\n',
    );
    process.exit(1);
  }
  if (keys.length === 1) {
    console.log(
      "[probe] Only one key configured. This still maps that key's limits, but it\n" +
        '        cannot tell you whether those limits belong to the KEY or to the\n' +
        '        SERVICE. Add a second key to answer that.',
    );
  }

  /*
   * A small AOI inside a region we already ingest, so the request is
   * unambiguously well-formed. If it fails, the failure is about the key or
   * the parameter under test - not about a bbox the service dislikes.
   */
  const region = getRegion('phoenix');
  const bbox = smallBboxWithin(region.tiles[0].bbox);
  const today = arizonaToday();

  const reports: KeyReport[] = [];

  for (const key of keys) {
    console.log(`\n[probe] ===== ${key.name} =====`);
    const report: KeyReport = { name: key.name, filterTypes: [], horizon: [] };

    console.log('[probe] filter_type support (date = today, smallest AOI):');
    for (const { ft, label } of FILTER_TYPES) {
      const r = await attempt(key, bbox, today, ft);
      report.filterTypes.push({ filterType: ft, label, ...r });
      console.log(`  filter_type ${ft} ${pad(label, 22)} ${verdict(r)}`);
    }

    /* Horizon is only meaningful on a filter type that works at all. */
    const workingFt = report.filterTypes.find((f) => f.ok)?.filterType ?? 3;
    console.log(`[probe] forecast horizon (filter_type ${workingFt}):`);
    for (const off of HORIZON_OFFSETS) {
      const date = addDays(today, off);
      const r = await attempt(key, bbox, date, workingFt);
      report.horizon.push({ dayOffset: off, date, ...r });
      console.log(`  today+${pad(String(off), 2)} ${date}  ${verdict(r)}`);
    }

    if (poll) {
      const accepted = report.horizon.find((h) => h.ok && h.activityId);
      if (accepted?.activityId) {
        console.log(`[probe] polling ${accepted.activityId} to completion...`);
        try {
          const result = await clientFor(key).pollActivity(
            accepted.activityId,
            (a, st) => console.log(`    poll ${a} -> ${st}`),
          );
          console.log(`    completed: ${result.cells.length} cells`);
        } catch (err) {
          console.log(`    poll failed: ${msg(err)}`);
        }
      }
    }

    reports.push(report);
  }

  summarise(reports);

  const dir = resolve(process.cwd(), 'docs');
  mkdirSync(dir, { recursive: true });
  const out = resolve(dir, 'key-probe.json');
  writeFileSync(
    out,
    JSON.stringify({ probedAt: new Date().toISOString(), keys: reports }, null, 1),
  );
  console.log(`\n[probe] Written to ${out} (env var names only, no key material).\n`);
}

/* -------------------------------------------------------------------------- */

function clientFor(key: ApiKey) {
  return new FortyGuardClient({
    apiKey: key.value,
    baseUrl: process.env.FORTYGUARD_BASE_URL?.trim() || 'https://api.fortyguard.com',
  });
}

/** One submission. Never polls - a request destined to 500 does so at submit. */
async function attempt(
  key: ApiKey,
  bbox: [number, number, number, number],
  date: string,
  filterType: number,
): Promise<Attempt> {
  const started = Date.now();
  try {
    const submitted = await clientFor(key).submitHeatmap({
      bbox,
      date,
      filterType: filterType as 1 | 3,
    });
    return {
      ok: true,
      status: 200,
      activityId: submitted.activityId,
      message: null,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: (err as { status?: number })?.status ?? null,
      activityId: null,
      message: msg(err),
      ms: Date.now() - started,
    };
  }
}

/**
 * The point of the whole script: say plainly whether a limit belongs to the
 * key or to the service, which is only answerable by comparing keys.
 */
function summarise(reports: KeyReport[]) {
  console.log('\n[probe] ===== SUMMARY =====');

  for (const { ft, label } of FILTER_TYPES) {
    const results = reports.map((r) => ({
      key: r.name,
      ok: r.filterTypes.find((f) => f.filterType === ft)?.ok ?? false,
    }));
    const anyOk = results.some((r) => r.ok);
    const allOk = results.every((r) => r.ok);
    const scope =
      reports.length < 2
        ? 'single key - scope unknown'
        : allOk
          ? 'works on every key'
          : anyOk
            ? `KEY-SCOPED - works on: ${results
                .filter((r) => r.ok)
                .map((r) => r.key)
                .join(', ')}`
            : 'fails on every key - a service limit, not a key limit';
    console.log(`  filter_type ${ft} ${pad(label, 22)} ${scope}`);
  }

  for (const r of reports) {
    const reached = r.horizon.filter((h) => h.ok).map((h) => h.dayOffset);
    console.log(
      `  ${pad(r.name, 24)} horizon reaches today+${
        reached.length ? Math.max(...reached) : '(none)'
      }`,
    );
  }

  const historicWorks = reports.some(
    (r) => r.filterTypes.find((f) => f.filterType === 1)?.ok,
  );
  console.log(
    historicWorks
      ? '\n  ACTION: historic (filter_type 1) is available. The Planner is already\n' +
          '  written to read historic - see the note in lib/config.ts - so this is a\n' +
          '  switch to flip rather than a feature to build.'
      : '\n  Historic remains unavailable on every key tested. The forecast-only\n' +
          '  labelling in the UI stays correct.',
  );
}

/** A ~0.01 degree box inside a known-good tile: valid, and the cheapest ask. */
function smallBboxWithin(
  t: [number, number, number, number],
): [number, number, number, number] {
  const lon = (t[0] + t[2]) / 2;
  const lat = (t[1] + t[3]) / 2;
  return [lon - 0.005, lat - 0.005, lon + 0.005, lat + 0.005];
}

function verdict(r: Attempt): string {
  return r.ok
    ? `OK    accepted in ${r.ms} ms (${r.activityId?.slice(0, 8)}...)`
    : `FAIL  ${r.status ?? 'network'} ${r.message ?? ''}`.trim();
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

main().catch((err) => {
  console.error('[probe] failed:', err);
  process.exit(1);
});

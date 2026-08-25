'use client';

/**
 * Ground truth - what the street actually looks like at a sampled point.
 *
 * Every other layer in this product describes a place as a number seen from
 * above. This one shows it from eye level and puts measured composition next to
 * the picture: how much of the frame is tree, sky, building, road.
 *
 * The reason it belongs in the Planner rather than being a curiosity: it is the
 * only measurement in the app that speaks to whether a canopy intervention is
 * even possible at a site. `canopyHeadroom` draws that line explicitly, and the
 * panel repeats it - segmentation measures COVER, not degrees, so the
 * intervention's degF figure stays the labelled assumption it has always been.
 */
import { useMemo, useState } from 'react';
import { canopyHeadroom } from '@/lib/assumptions';
import { Chip, Empty, SectionLabel } from './ui';

export interface GroundPoint {
  id: string;
  label: string;
  lat: number;
  lon: number;
  street: Record<string, number> | null;
  overhead: Record<string, number> | null;
  imageDate: string | null;
  imageYear: string | number | null;
  streetImage: string | null;
  streetSegmented: string | null;
}

export interface GroundFile {
  regionId: string;
  snapshotDate: string;
  fetchedAt: string;
  note: string;
  points: GroundPoint[];
}

/** Colours echo the segmentation legend: green canopy, blue sky, grey built. */
const SEGMENT_COLORS: Record<string, string> = {
  tree: '#16a34a',
  plant: '#16a34a',
  sky: '#38bdf8',
  building: '#a8a29e',
  road: '#57534e',
  'road, route': '#57534e',
  sidewalk: '#d6d3d1',
  earth: '#a16207',
  'earth, ground': '#a16207',
  car: '#f97316',
  fence: '#78716c',
  others: '#44403c',
};

export default function GroundPanel({ ground }: { ground: GroundFile | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSegmented, setShowSegmented] = useState(true);

  // Memoised rather than `ground?.points ?? []` inline: the fallback literal is
  // a fresh array every render, which would invalidate the memo below on every
  // pass and re-run the lookup for nothing.
  const points = useMemo(() => ground?.points ?? [], [ground]);
  const selected = useMemo(
    () => points.find((p) => p.id === selectedId) ?? points[0] ?? null,
    [points, selectedId],
  );

  if (!ground || points.length === 0) {
    return (
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel>Ground truth</SectionLabel>
        <Empty>
          No ground segmentation for this region. Run{' '}
          <span className="num">npm run data:ground</span> with a key.
        </Empty>
      </section>
    );
  }

  const reading = selected?.street ? canopyHeadroom(selected.street) : null;
  const image =
    showSegmented && selected?.streetSegmented
      ? selected.streetSegmented
      : selected?.streetImage;

  return (
    <section className="p-4 border-b border-[var(--color-hairline)]">
      <SectionLabel right={<Chip tone="relief">measured</Chip>}>Ground truth</SectionLabel>

      {/* ------------------------------------------------------ point picker */}
      <div className="flex flex-wrap gap-1 mb-3">
        {points.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            aria-pressed={selected?.id === p.id}
            className="btn py-1 text-[10.5px]"
            style={{
              borderColor:
                selected?.id === p.id ? 'var(--color-ember)' : 'var(--color-hairline)',
              color:
                selected?.id === p.id ? 'var(--color-ember)' : 'var(--color-muted)',
              background:
                selected?.id === p.id
                  ? 'var(--color-surface-3)'
                  : 'var(--color-surface-2)',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {selected ? (
        <>
          {/* --------------------------------------------------------- image */}
          {image ? (
            <figure className="mb-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/jpeg;base64,${image}`}
                alt={
                  showSegmented
                    ? `Segmented street view at ${selected.label}`
                    : `Street view at ${selected.label}`
                }
                className="w-full border border-[var(--color-hairline)]"
              />
              <figcaption className="flex items-center justify-between mt-1.5">
                <span className="text-[10px] text-[var(--color-faint)]">
                  {selected.imageDate
                    ? `Imagery ${selected.imageDate}`
                    : 'Street-level imagery'}{' '}
                  &middot; via FortyGuard
                </span>
                {selected.streetSegmented ? (
                  <button
                    onClick={() => setShowSegmented((s) => !s)}
                    className="label hover:text-[var(--color-bone)]"
                  >
                    {showSegmented ? 'show photo' : 'show segmentation'}
                  </button>
                ) : null}
              </figcaption>
            </figure>
          ) : (
            <p className="text-[10.5px] text-[var(--color-faint)] mb-3 leading-relaxed">
              Composition measured here; imagery is kept for the first few points only,
              because a segmented frame is larger than every heat grid in this region
              combined.
            </p>
          )}

          {/* -------------------------------------------------- composition */}
          {selected.street ? (
            <>
              <div className="label mb-1.5">Street frame composition</div>
              <SegmentBar segments={selected.street} />
            </>
          ) : null}

          {selected.overhead ? (
            <>
              <div className="label mb-1.5 mt-3">
                Land cover from above
                {selected.imageYear ? (
                  <span className="num ml-1 text-[var(--color-faint)]">
                    {selected.imageYear}
                  </span>
                ) : null}
              </div>
              <SegmentBar segments={selected.overhead} />
            </>
          ) : null}

          {/* ------------------------------------------------ canopy headroom */}
          {reading ? (
            <div
              className="mt-3 px-2.5 py-2 border"
              style={{
                borderColor: reading.indoor
                  ? 'var(--color-warn)'
                  : reading.band!.headroom === 'low'
                    ? 'var(--color-hairline-bright)'
                    : 'var(--color-relief)',
                background: reading.indoor
                  ? 'color-mix(in oklab, var(--color-warn) 8%, transparent)'
                  : reading.band!.headroom === 'low'
                    ? 'var(--color-surface-2)'
                    : 'color-mix(in oklab, var(--color-relief) 8%, transparent)',
              }}
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-[12px] font-semibold text-[var(--color-bone)]">
                  {reading.indoor ? 'Interior view' : reading.band!.label}
                </span>
                <Chip
                  tone={
                    reading.indoor || reading.band!.headroom === 'low' ? 'warn' : 'relief'
                  }
                >
                  {reading.indoor ? 'not a street' : `${reading.band!.headroom} headroom`}
                </Chip>
              </div>
              <p className="text-[10.5px] leading-relaxed text-[var(--color-muted)]">
                {reading.note}
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      <p className="text-[10px] leading-relaxed text-[var(--color-faint)] mt-3">
        {ground.note}
      </p>
    </section>
  );
}

/** A stacked proportion bar plus the three largest classes named underneath. */
function SegmentBar({ segments }: { segments: Record<string, number> }) {
  const entries = Object.entries(segments)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;

  return (
    <>
      <div className="flex h-[14px] w-full overflow-hidden border border-[var(--color-hairline)]">
        {entries.map(([k, v]) => (
          <span
            key={k}
            title={`${k} ${v.toFixed(1)}%`}
            style={{
              width: `${(v / total) * 100}%`,
              background: SEGMENT_COLORS[k] ?? '#44403c',
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
        {entries.slice(0, 5).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5 text-[10px]">
            <span
              className="w-[8px] h-[8px] shrink-0"
              style={{ background: SEGMENT_COLORS[k] ?? '#44403c' }}
            />
            <span className="text-[var(--color-muted)]">{k}</span>
            <span className="num text-[var(--color-bone)]">{v.toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </>
  );
}

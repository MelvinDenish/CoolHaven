'use client';

/**
 * Map legend, layer switch and drawing HUD, docked over the canvas.
 *
 * The temperature ramp is generated from `tempColor` and the risk swatches
 * from the band table served by the API, rather than hand-written CSS. A
 * legend that can drift from the pixels it describes is worse than no legend.
 */
import { useState } from 'react';
import { tempColor } from '@/lib/grid';
import { INTERVENTIONS, THRESHOLDS } from '@/lib/assumptions';
import type { MapLayers } from './MapCanvas';
import { BASEMAPS, type BasemapId } from '@/lib/basemaps';
import type { InterventionKind } from '@/lib/types';

const RAMP_STOPS = [84, 88, 92, 96, 100, 104, 108, 112, 116];

/** The three mutually exclusive cell paintings. */
export type ThemeKey = 'heat' | 'risk' | 'demand';

interface Props {
  layers: MapLayers;
  onToggle: (key: keyof MapLayers) => void;
  /** Selects one cell painting, or none. Clears the other two. */
  onTheme: (t: ThemeKey | 'none') => void;
  showDemand: boolean;
  cellRiskBands: ReadonlyArray<{ index: number; label: string; color: string }>;
  placing: InterventionKind | null;
  corridorPoints: number;
  onFinishCorridor: () => void;
  onCancelPlacing: () => void;
  basemap: BasemapId;
  onBasemapChange: (b: BasemapId) => void;
  /** False while /api/streets is still in flight, so the hint can say so. */
  streetsReady: boolean;
}

export default function Legend({
  layers,
  onToggle,
  onTheme,
  showDemand,
  cellRiskBands,
  placing,
  corridorPoints,
  onFinishCorridor,
  onCancelPlacing,
  basemap,
  onBasemapChange,
  streetsReady,
}: Props) {
  /*
   * Two kinds of layer, and they behave differently on purpose.
   *
   * Work exposure, temperature and risk are three DIFFERENT colour ramps
   * painted over the same cells. Letting all three run at once produced mud -
   * and worse, mud that looks like data. They are one-of-three now, which
   * removes a decision rather than adding one.
   *
   * The rest are genuinely additive: relief sites, routes, parks and the
   * planned moves are distinct marks that read fine stacked, so they stay
   * independent checkboxes.
   */
  const themes: Array<{ key: ThemeKey; label: string; hint: string; show: boolean }> = [
    {
      key: 'demand',
      label: 'Work exposure',
      hint: 'Where outdoor work meets heat. This is what siting is driven by.',
      show: showDemand,
    },
    {
      key: 'heat',
      label: 'Temperature',
      hint: 'Continuous 2 m air temperature for the reading on screen.',
      show: true,
    },
    {
      key: 'risk',
      label: 'Risk bands',
      hint: 'Each cell sorted into a band at ingest, not on render.',
      show: true,
    },
  ];

  const overlays: Array<{ key: keyof MapLayers; label: string; show: boolean }> = [
    { key: 'relief', label: 'Relief network', show: true },
    { key: 'routes', label: 'Routes', show: true },
    { key: 'context', label: 'Parks and water', show: true },
    { key: 'interventions', label: 'Planned moves', show: true },
  ];

  /* Demand wins if somehow two are set: it is the most specific answer. */
  const activeTheme: ThemeKey | 'none' = layers.demand
    ? 'demand'
    : layers.risk
      ? 'risk'
      : layers.heat
        ? 'heat'
        : 'none';

  const drawingCorridor = placing !== null && INTERVENTIONS[placing].geometry === 'corridor';
  // Open on desktop, closed on a phone where it would cover the map.
  const [open, setOpen] = useState(true);

  return (
    <>
      {placing ? (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-3 px-3.5 py-2 border border-[var(--color-ember)] bg-[var(--color-void)]/95 rise"
          role="status"
        >
          <span
            className="live-dot inline-block w-[7px] h-[7px]"
            style={{ background: INTERVENTIONS[placing].color }}
          />
          <span className="label" style={{ color: 'var(--color-ember)' }}>
            {drawingCorridor
              ? `Click along the street to draw a ${INTERVENTIONS[placing].short.toLowerCase()} corridor`
              : `Click the map to place: ${INTERVENTIONS[placing].label}`}
          </span>

          {drawingCorridor ? (
            <>
              <span className="num text-[11px] text-[var(--color-muted)]">
                {corridorPoints} point{corridorPoints === 1 ? '' : 's'}
              </span>
              <button
                onClick={onFinishCorridor}
                disabled={corridorPoints < 2}
                className="btn btn-primary py-1 px-2.5"
              >
                Finish corridor
              </button>
            </>
          ) : null}

          <button
            onClick={onCancelPlacing}
            className="label hover:text-[var(--color-bone)]"
          >
            esc
          </button>
        </div>
      ) : null}

      <button
        onClick={() => setOpen((o) => !o)}
        className="lg:hidden absolute bottom-4 left-4 z-[1001] btn"
        aria-expanded={open}
      >
        {open ? 'Hide legend' : 'Legend'}
      </button>

      <div
        className={`legend-panel absolute bottom-4 left-4 z-[1000] panel px-3.5 py-3 w-[236px] bg-[var(--color-void)]/92 backdrop-blur-sm ${
          open ? '' : 'hidden'
        } max-lg:bottom-[68px]`}
      >
        {/* The swatch key always describes whichever painting is active. */}
        {activeTheme === 'risk' ? (
          <>
            <div className="label mb-2">Cell risk classification</div>
            <div className="flex flex-col gap-1 mb-2">
              {cellRiskBands.map((band) => (
                <span key={band.index} className="flex items-center gap-2">
                  <span
                    className="w-[13px] h-[9px] shrink-0"
                    style={{ background: band.color }}
                  />
                  <span className="text-[10.5px] text-[var(--color-muted)]">
                    {band.label}
                  </span>
                </span>
              ))}
            </div>
            <div className="text-[9.5px] leading-snug text-[var(--color-faint)] mb-3">
              Stored per cell at ingest, not derived on render.
            </div>
          </>
        ) : activeTheme === 'demand' ? (
          <>
            <div className="label mb-2">Work exposure</div>
            <div
              className="h-[9px] mb-1.5"
              style={{
                background:
                  'linear-gradient(to right, rgba(255,107,26,0.05), rgba(255,107,26,0.95))',
              }}
            />
            <div className="flex justify-between num text-[9.5px] text-[var(--color-faint)] mb-2">
              <span>0.0</span>
              <span style={{ color: 'var(--color-muted)' }}>index</span>
              <span>1.0</span>
            </div>
            <div className="text-[9.5px] leading-snug text-[var(--color-faint)] mb-3">
              Heat, road length and route density combined. 1.0 is the highest cell in
              this focus area, not an absolute scale.
            </div>
          </>
        ) : activeTheme === 'heat' ? (
          <>
            <div className="label mb-2">2 m air temperature</div>
            <div className="flex h-[9px] mb-1.5">
              {RAMP_STOPS.map((t) => (
                <div key={t} className="flex-1" style={{ background: tempColor(t) }} />
              ))}
            </div>
            <div className="flex justify-between num text-[9.5px] text-[var(--color-faint)] mb-3">
              <span>{RAMP_STOPS[0]}</span>
              <span style={{ color: 'var(--color-muted)' }}>{THRESHOLDS.cautionF}</span>
              <span>{RAMP_STOPS[RAMP_STOPS.length - 1]} °F</span>
            </div>
          </>
        ) : (
          <div className="text-[10.5px] leading-snug text-[var(--color-faint)] mb-3">
            Basemap only. Pick a colouring below to paint the cells.
          </div>
        )}

        <div className="rule-ticked mb-3" />

        <fieldset className="flex flex-col gap-1 mb-1">
          <legend className="label mb-1.5">Colour the map by</legend>
          {themes
            .filter((t) => t.show)
            .map((t) => (
              <ThemeRadio
                key={t.key}
                label={t.label}
                hint={t.hint}
                on={activeTheme === t.key}
                onSelect={() => onTheme(t.key)}
              />
            ))}
          <ThemeRadio
            label="Nothing"
            hint="Show the basemap alone."
            on={activeTheme === 'none'}
            onSelect={() => onTheme('none')}
          />
        </fieldset>

        <div className="rule my-2.5" />

        <fieldset className="flex flex-col gap-1.5">
          <legend className="label mb-1.5">Also show</legend>
          {overlays
            .filter((t) => t.show)
            .map((t) => (
              <label
                key={t.key}
                className="flex items-center gap-2 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={layers[t.key]}
                  onChange={() => onToggle(t.key)}
                  className="sr-only peer"
                />
                <span
                  aria-hidden
                  className="w-[11px] h-[11px] border shrink-0 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--color-ember)]"
                  style={{
                    borderColor: layers[t.key]
                      ? 'var(--color-ember)'
                      : 'var(--color-hairline-bright)',
                    background: layers[t.key] ? 'var(--color-ember)' : 'transparent',
                  }}
                />
                <span
                  className="text-[11px] transition-colors"
                  style={{
                    color: layers[t.key] ? 'var(--color-bone)' : 'var(--color-faint)',
                  }}
                >
                  {t.label}
                </span>
              </label>
            ))}
        </fieldset>

        {layers.relief ? (
          <>
            <div className="rule my-3" />
            <div className="flex flex-col gap-1.5 text-[10.5px] text-[var(--color-muted)]">
              <LegendDot color="#45c8e6" label="Cooling centre" />
              <LegendDot color="#2f9fbb" label="Hydration station" />
              <LegendDot color="#9ae6f5" label="Respite centre" />
              <LegendDot color="#6d6459" label="Closed at this reading" hollow />
              <LegendDot color="#ff6b1a" label="Proposed move" hollow />
            </div>
          </>
        ) : null}

        <div className="rule my-3" />

        {/* --------------------------------------------------------- ground */}
        <div className="label mb-2">Ground</div>
        <div className="grid grid-cols-2 gap-1 mb-2">
          {(Object.keys(BASEMAPS) as BasemapId[]).map((id) => (
            <button
              key={id}
              onClick={() => onBasemapChange(id)}
              aria-pressed={basemap === id}
              className="btn py-1"
              style={{
                borderColor:
                  basemap === id ? 'var(--color-ember)' : 'var(--color-hairline)',
                color: basemap === id ? 'var(--color-ember)' : 'var(--color-muted)',
                background:
                  basemap === id ? 'var(--color-surface-3)' : 'var(--color-surface-2)',
              }}
            >
              {BASEMAPS[id].label}
            </button>
          ))}
        </div>
        <p className="text-[10px] leading-relaxed text-[var(--color-faint)]">
          {streetsReady
            ? 'Click any street for its temperature along the whole length, for the day and reading on screen.'
            : 'Loading street centrelines...'}
        </p>
      </div>
    </>
  );
}

/** One of the mutually exclusive cell paintings. */
function ThemeRadio({
  label,
  hint,
  on,
  onSelect,
}: {
  label: string;
  hint: string;
  on: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      title={hint}
      className="flex items-center gap-2 cursor-pointer select-none"
    >
      <input
        type="radio"
        name="map-theme"
        checked={on}
        onChange={onSelect}
        className="sr-only peer"
      />
      <span
        aria-hidden
        className="w-[11px] h-[11px] rounded-full border shrink-0 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--color-ember)]"
        style={{
          borderColor: on ? 'var(--color-ember)' : 'var(--color-hairline-bright)',
          background: on ? 'var(--color-ember)' : 'transparent',
          boxShadow: on ? 'inset 0 0 0 2px var(--color-void)' : 'none',
        }}
      />
      <span
        className="text-[11px] transition-colors"
        style={{ color: on ? 'var(--color-bone)' : 'var(--color-faint)' }}
      >
        {label}
      </span>
    </label>
  );
}

function LegendDot({
  color,
  label,
  hollow,
}: {
  color: string;
  label: string;
  hollow?: boolean;
}) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="w-[9px] h-[9px] rounded-full shrink-0"
        style={{
          background: hollow ? 'transparent' : color,
          border: `1.5px ${hollow ? 'dashed' : 'solid'} ${color}`,
        }}
      />
      {label}
    </span>
  );
}

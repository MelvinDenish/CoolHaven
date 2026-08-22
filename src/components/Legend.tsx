'use client';

/**
 * Map legend, layer switch and drawing HUD, docked over the canvas.
 *
 * The temperature ramp is generated from `tempColor` and the risk swatches
 * from the band table served by the API, rather than hand-written CSS. A
 * legend that can drift from the pixels it describes is worse than no legend.
 */
import { tempColor } from '@/lib/grid';
import { INTERVENTIONS, THRESHOLDS } from '@/lib/assumptions';
import type { MapLayers } from './MapCanvas';
import type { InterventionKind } from '@/lib/types';

const RAMP_STOPS = [84, 88, 92, 96, 100, 104, 108, 112, 116];

interface Props {
  layers: MapLayers;
  onToggle: (key: keyof MapLayers) => void;
  showDemand: boolean;
  cellRiskBands: ReadonlyArray<{ index: number; label: string; color: string }>;
  placing: InterventionKind | null;
  corridorPoints: number;
  onFinishCorridor: () => void;
  onCancelPlacing: () => void;
}

export default function Legend({
  layers,
  onToggle,
  showDemand,
  cellRiskBands,
  placing,
  corridorPoints,
  onFinishCorridor,
  onCancelPlacing,
}: Props) {
  const toggles: Array<{ key: keyof MapLayers; label: string; show: boolean }> = [
    { key: 'heat', label: 'Heat field (continuous)', show: true },
    { key: 'risk', label: 'Risk classification', show: true },
    { key: 'demand', label: 'Exposure demand', show: showDemand },
    { key: 'context', label: 'Parks and water', show: true },
    { key: 'relief', label: 'Relief network', show: true },
    { key: 'routes', label: 'Routes', show: true },
    { key: 'interventions', label: 'Scenario', show: true },
  ];

  const drawingCorridor = placing !== null && placing !== 'cooling_station';

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

      <div className="absolute bottom-4 left-4 z-[1000] panel px-3.5 py-3 w-[236px] bg-[var(--color-void)]/92 backdrop-blur-sm">
        {layers.risk ? (
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
        ) : (
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
              <span>{RAMP_STOPS[RAMP_STOPS.length - 1]} degF</span>
            </div>
          </>
        )}

        <div className="rule-ticked mb-3" />

        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">Map layers</legend>
          {toggles
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
              <LegendDot color="#6d6459" label="Closed at this hour" hollow />
              <LegendDot color="#ff6b1a" label="Proposed (scenario)" hollow />
            </div>
          </>
        ) : null}
      </div>
    </>
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

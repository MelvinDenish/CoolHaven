/**
 * POST /api/export/forma?format=geojson|csv
 *
 * Turns the current scenario into a downloadable file (Addition 1).
 *
 * Base PRD section 6.6 had export on the cut list as a nice-to-have; the
 * additions promote it to core, because a recommendation a planner cannot get
 * out of the browser tab is not a recommendation a planner can act on.
 *
 * The endpoint exists rather than doing this in the browser for one reason:
 * Content-Disposition. A server-set download filename is what makes the export
 * land as `coolroute-scenario.geojson` in Downloads instead of as a blob the
 * user has to name themselves.
 */
import { NextResponse } from 'next/server';
import { buildFormaExport, toCsv } from '@/lib/forma-export';
import type { ExportContext } from '@/lib/forma-export';
import type { Intervention } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface ExportBody {
  scenarioName?: string;
  interventions?: Intervention[];
  context?: Partial<ExportContext>;
}

export async function POST(req: Request) {
  const format = new URL(req.url).searchParams.get('format') ?? 'geojson';

  let body: ExportBody;
  try {
    body = (await req.json()) as ExportBody;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const interventions = body.interventions ?? [];
  if (interventions.length === 0) {
    return NextResponse.json(
      { error: 'Nothing to export - the scenario has no interventions.' },
      { status: 400 },
    );
  }

  const scenarioName = body.scenarioName?.trim() || 'CoolRoute scenario';
  const stamp = new Date().toISOString();
  const slug =
    scenarioName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'scenario';

  if (format === 'csv') {
    return new NextResponse(toCsv(interventions), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="coolroute-${slug}.csv"`,
      },
    });
  }

  const ctx: ExportContext = {
    scenarioName,
    generatedAt: stamp,
    heatDataSource: body.context?.heatDataSource ?? 'unknown',
    heatValidAt: body.context?.heatValidAt ?? stamp,
    filterType: body.context?.filterType ?? 1,
    before: body.context?.before ?? {
      exposureIndex: 0,
      coverageShare: 0,
      meanTempF: 0,
    },
    after: body.context?.after ?? { exposureIndex: 0, coverageShare: 0, meanTempF: 0 },
  };

  const payload = buildFormaExport(interventions, ctx);

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      // The GeoJSON media type, so a tool that sniffs content-type recognises
      // the file rather than treating it as generic JSON.
      'content-type': 'application/geo+json; charset=utf-8',
      'content-disposition': `attachment; filename="coolroute-${slug}.geojson"`,
    },
  });
}

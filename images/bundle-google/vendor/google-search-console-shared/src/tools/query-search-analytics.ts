import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, READ_ANNOTATIONS, type Tool } from '../tools.js';
import { addDays, isIsoDate, normalizeSiteUrl, pacificDate, SITE_URL_DESCRIPTION } from '../utils/site-url.js';
import { logError } from '../logging.js';
import type { SearchAnalyticsRequest, SearchAnalyticsRow } from '../types.js';

export const DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'hour', 'searchAppearance'] as const;
export const FILTER_DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const;
export const OPERATORS = [
  'equals',
  'contains',
  'notEquals',
  'notContains',
  'includingRegex',
  'excludingRegex',
] as const;
export const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
export const AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] as const;
export const DATA_STATES = ['final', 'all', 'hourly_all'] as const;

export const DEFAULT_ROW_LIMIT = 100;
/** The API's own ceiling for one request. */
export const MAX_ROW_LIMIT = 25_000;
/** Days in the default window, ending today: Search Console's own default report. */
export const DEFAULT_WINDOW_DAYS = 28;

const date = z.string().refine(isIsoDate, { message: 'must be a date written YYYY-MM-DD, e.g. 2026-10-01' });

export const QuerySearchAnalyticsSchema = z
  .object({
    site_url: z.string().min(1),
    start_date: date.optional(),
    end_date: date.optional(),
    dimensions: z
      .array(z.enum(DIMENSIONS))
      .max(DIMENSIONS.length)
      .refine((d) => new Set(d).size === d.length, { message: 'must not name a dimension twice' })
      .default([]),
    type: z.enum(SEARCH_TYPES).default('web'),
    filters: z
      .array(
        z.object({
          dimension: z.enum(FILTER_DIMENSIONS),
          operator: z.enum(OPERATORS).default('equals'),
          expression: z.string().min(1),
        })
      )
      .max(20)
      .default([]),
    aggregation_type: z.enum(AGGREGATION_TYPES).optional(),
    row_limit: z.number().int().min(1).max(MAX_ROW_LIMIT).default(DEFAULT_ROW_LIMIT),
    start_row: z.number().int().min(0).default(0),
    data_state: z.enum(DATA_STATES).optional(),
  })
  .strict();

export type QuerySearchAnalyticsArgs = z.infer<typeof QuerySearchAnalyticsSchema>;

/** The tool's arguments as the API's request body, with the date window filled in. */
export function buildRequest(args: QuerySearchAnalyticsArgs, today: Date = new Date()): SearchAnalyticsRequest {
  const endDate = args.end_date ?? pacificDate(today);
  const startDate = args.start_date ?? addDays(endDate, -(DEFAULT_WINDOW_DAYS - 1));
  if (startDate > endDate) {
    throw new Error(`start_date ${startDate} is after end_date ${endDate}.`);
  }
  const request: SearchAnalyticsRequest = {
    startDate,
    endDate,
    type: args.type,
    rowLimit: args.row_limit,
    startRow: args.start_row,
  };
  if (args.dimensions.length > 0) request.dimensions = [...args.dimensions];
  if (args.filters.length > 0) request.dimensionFilterGroups = [{ groupType: 'and', filters: args.filters }];
  if (args.aggregation_type) request.aggregationType = args.aggregation_type;
  if (args.data_state) request.dataState = args.data_state;
  return request;
}

/** A key as one TSV cell: tabs and newlines in a query would break the row. */
function cell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

function formatRow(row: SearchAnalyticsRow): string {
  const ctr = typeof row.ctr === 'number' ? `${(row.ctr * 100).toFixed(2)}%` : '';
  const position = typeof row.position === 'number' ? row.position.toFixed(1) : '';
  return [...(row.keys ?? []).map(cell), String(row.clicks ?? 0), String(row.impressions ?? 0), ctr, position].join(
    '\t'
  );
}

export function renderRows(
  siteUrl: string,
  request: SearchAnalyticsRequest,
  rows: SearchAnalyticsRow[],
  aggregation: string | undefined
): string {
  const dims = request.dimensions ?? [];
  const lines = [
    `Search analytics for ${siteUrl}, ${request.startDate} to ${request.endDate} ` +
      `(type ${request.type ?? 'web'}, data_state ${request.dataState ?? 'final'}` +
      `${aggregation ? `, aggregated ${aggregation}` : ''})` +
      `${dims.length > 0 ? `, by ${dims.join(', ')}` : ', totals'}.`,
  ];
  if (rows.length === 0) {
    lines.push(
      request.startRow
        ? `No rows from start_row ${request.startRow}: the previous page was the last.`
        : 'No rows. Search Console has no data for this window and these filters. Its data runs two to three ' +
            'days behind: data_state "all" includes the most recent, not yet final, days.'
    );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `${rows.length} row${rows.length === 1 ? '' : 's'}${request.startRow ? ` from start_row ${request.startRow}` : ''}. ` +
      'ctr is clicks / impressions; position is the average rank, 1 is the top.',
    '',
    [...dims, 'clicks', 'impressions', 'ctr', 'position'].join('\t'),
    ...rows.map(formatRow)
  );
  if (rows.length === request.rowLimit) {
    lines.push('', `More rows may exist: call again with start_row ${(request.startRow ?? 0) + rows.length}.`);
  }
  return `${lines.join('\n')}\n`;
}

const DESCRIPTION = `Query a property's Google Search performance: clicks, impressions, click-through rate and average position, grouped by the dimensions you choose.

**Returns** a header and tab-separated rows, for example with dimensions ["query", "device"]:

Search analytics for sc-domain:example.com, 2026-10-01 to 2026-10-28 (type web, data_state final, aggregated byProperty), by query, device.
2 rows. ctr is clicks / impressions; position is the average rank, 1 is the top.

query	device	clicks	impressions	ctr	position
example pricing	MOBILE	412	5210	7.91%	3.2
example login	DESKTOP	388	901	43.06%	1.1

More rows may exist: call again with start_row 2.

With no dimensions it returns one row of totals. Data runs two to three days behind, and the window defaults to the 28 days ending today in Pacific time, Search Console's day.

**dimensions** (row grouping, in order): query (the search text), page (the landing URL), country (ISO 3166-1 alpha-3, lowercase, e.g. "usa"), device (DESKTOP, MOBILE, TABLET), date (YYYY-MM-DD), hour (needs data_state "hourly_all"), searchAppearance (rich result types, e.g. AMP_BLUE_LINK; best queried alone).

**type**: web (default), image, video, news (the News tab in Search), discover, googleNews (news.google.com and the News app).

**filters**: every filter must match (AND). operator is equals (default), contains, notEquals, notContains, includingRegex or excludingRegex (RE2 syntax). Example: [{"dimension": "page", "operator": "contains", "expression": "/blog/"}].

**aggregation_type**: auto (default, Google picks), byProperty (a result counts once per search; not allowed with the page dimension or a page filter), byPage (counts once per page shown), byNewsShowcasePanel (counts once per News Showcase panel; only with type discover or googleNews, a searchAppearance filter equals NEWS_SHOWCASE, and no page or searchAppearance dimension).

**data_state**: final (default, settled data only), all (includes fresh, not yet final data), hourly_all (fresh data, needed for the hour dimension).

**Use cases:**
- Top queries for a site last month: dimensions ["query"], row_limit 50
- Which pages lost clicks: two calls with dimensions ["page"] over two windows
- Daily trend: dimensions ["date"]
- Performance of one section: filters on page contains "/docs/"
- Mobile vs desktop for one query: dimensions ["device"], filters on query equals "..."
- Brand vs non-brand: filters on query includingRegex / excludingRegex "example"`;

export function querySearchAnalyticsTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'query_search_analytics',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        site_url: { type: 'string', description: SITE_URL_DESCRIPTION },
        start_date: {
          type: 'string',
          description: `First day, inclusive, YYYY-MM-DD (Pacific time, as Search Console reports). Default: ${DEFAULT_WINDOW_DAYS - 1} days before end_date.`,
        },
        end_date: {
          type: 'string',
          description: 'Last day, inclusive, YYYY-MM-DD. Default: today in Pacific time.',
        },
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: [...DIMENSIONS] },
          description: 'How to group rows, in column order. Default: none, which returns one row of totals.',
        },
        type: {
          type: 'string',
          enum: [...SEARCH_TYPES],
          description: 'Which search surface. Default: web.',
        },
        filters: {
          type: 'array',
          description: 'Row filters, all of which must match. Default: none.',
          items: {
            type: 'object',
            properties: {
              dimension: { type: 'string', enum: [...FILTER_DIMENSIONS] },
              operator: { type: 'string', enum: [...OPERATORS], description: 'Default: equals.' },
              expression: {
                type: 'string',
                description: 'The value to match, e.g. "/blog/", "usa", "MOBILE", or an RE2 regex.',
              },
            },
            required: ['dimension', 'expression'],
          },
        },
        aggregation_type: {
          type: 'string',
          enum: [...AGGREGATION_TYPES],
          description: 'How results are counted. Default: auto.',
        },
        row_limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_ROW_LIMIT,
          description: `Rows to return. Default ${DEFAULT_ROW_LIMIT}, at most ${MAX_ROW_LIMIT}.`,
        },
        start_row: {
          type: 'integer',
          minimum: 0,
          description: 'Zero-based offset for paging. Default 0; the output names the next value.',
        },
        data_state: {
          type: 'string',
          enum: [...DATA_STATES],
          description: 'Default: final.',
        },
      },
      required: ['site_url'],
    },
    annotations: { title: 'Query Search Console performance', ...READ_ANNOTATIONS },
    handler: async (args) => {
      try {
        const parsed = QuerySearchAnalyticsSchema.parse(args ?? {});
        const siteUrl = normalizeSiteUrl(parsed.site_url);
        const request = buildRequest(parsed);
        const result = await clientFactory().querySearchAnalytics(siteUrl, request);
        return {
          content: [
            { type: 'text', text: renderRows(siteUrl, request, result.rows ?? [], result.responseAggregationType) },
          ],
        };
      } catch (error) {
        logError('query-search-analytics-tool', error);
        return errorResult('Error querying Search Console', error);
      }
    },
  };
}

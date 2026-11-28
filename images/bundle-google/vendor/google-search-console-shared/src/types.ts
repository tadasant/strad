/**
 * The slices of the Search Console API resources this server reads.
 *
 * The interfaces keep an index signature so a field the renderers do not model
 * still survives a round trip through them.
 */

/** siteOwner | siteFullUser | siteRestrictedUser | siteUnverifiedUser */
export interface SiteEntry {
  siteUrl: string;
  permissionLevel?: string;
  [k: string]: unknown;
}

export interface SitesListResponse {
  siteEntry?: SiteEntry[];
  [k: string]: unknown;
}

export type SearchDimension = 'query' | 'page' | 'country' | 'device' | 'date' | 'hour' | 'searchAppearance';
export type FilterDimension = 'query' | 'page' | 'country' | 'device' | 'searchAppearance';
export type FilterOperator =
  | 'equals'
  | 'contains'
  | 'notEquals'
  | 'notContains'
  | 'includingRegex'
  | 'excludingRegex';
export type SearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
export type AggregationType = 'auto' | 'byPage' | 'byProperty' | 'byNewsShowcasePanel';
export type DataState = 'final' | 'all' | 'hourly_all';

export interface DimensionFilter {
  dimension: FilterDimension;
  operator: FilterOperator;
  expression: string;
}

/** The body of `searchAnalytics.query`, in the API's own field names. */
export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: SearchDimension[];
  type?: SearchType;
  dimensionFilterGroups?: Array<{ groupType: 'and'; filters: DimensionFilter[] }>;
  aggregationType?: AggregationType;
  rowLimit?: number;
  startRow?: number;
  dataState?: DataState;
}

export interface SearchAnalyticsRow {
  /** One value per requested dimension, in the requested order. */
  keys?: string[];
  clicks?: number;
  impressions?: number;
  /** A fraction, 0..1. */
  ctr?: number;
  /** Average position, 1 is the top. */
  position?: number;
  [k: string]: unknown;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
  [k: string]: unknown;
}

export interface SitemapContent {
  type?: string;
  /** int64 as a STRING, as Google reports it in JSON. */
  submitted?: string;
  indexed?: string;
  [k: string]: unknown;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
  contents?: SitemapContent[];
  [k: string]: unknown;
}

export interface SitemapsListResponse {
  sitemap?: Sitemap[];
  [k: string]: unknown;
}

export interface UrlInspectionRequest {
  inspectionUrl: string;
  siteUrl: string;
  languageCode?: string;
}

export interface IndexStatusResult {
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  sitemap?: string[];
  referringUrls?: string[];
  crawledAs?: string;
  [k: string]: unknown;
}

export interface RichResultsItem {
  name?: string;
  issues?: Array<{ issueMessage?: string; severity?: string }>;
  [k: string]: unknown;
}

export interface UrlInspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: IndexStatusResult;
  mobileUsabilityResult?: { verdict?: string; issues?: Array<{ message?: string; severity?: string }> };
  richResultsResult?: {
    verdict?: string;
    detectedItems?: Array<{ richResultType?: string; items?: RichResultsItem[] }>;
  };
  ampResult?: { verdict?: string; ampUrl?: string; indexingState?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface UrlInspectionResponse {
  inspectionResult?: UrlInspectionResult;
  [k: string]: unknown;
}

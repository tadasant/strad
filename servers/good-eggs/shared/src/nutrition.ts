import { extractStoreData } from './basketState.js';

/**
 * Nutrition for a Good Eggs product — what Good Eggs actually publishes, and
 * nothing it does not. See FORK.md #12.
 *
 * Good Eggs carries NO nutrition fields on a product: not in the page's
 * `storeData.productDetails`, not in JSON-LD, not in any API the product page
 * calls. The one structured source it links to is a set of Zendesk help-center
 * articles — one HTML table per category — covering products made by its own
 * kitchen (producer slug `goodeggskitchen`), and only the page for such a
 * product links there. Every other product has photos and nothing else, and the
 * photos are product photography, usually front of pack.
 *
 * So the answer has three parts, each of which says what it is:
 *   - `nutrition.status` — found, ambiguous, not in the tables, not published,
 *     or UNKNOWN (the tables could not be read). Never silently absent.
 *   - `images` — public CDN URLs the caller can fetch without a session.
 *   - the product's own identity (name, producer, retail units), so a caller
 *     can take it to a nutrition database when Good Eggs has nothing.
 */

/** The producer slug the product page gates its "View Nutritional Information" link on. */
export const KITCHEN_PRODUCER_SLUG = 'goodeggskitchen';

/** The help-center section that link points at. */
export const KITCHEN_NUTRITION_SECTION_URL =
  'https://help.goodeggs.com/hc/en-us/sections/360007686892-Good-Eggs-Kitchen-Nutritional-Information';

/**
 * The same section through Zendesk's public Help Center API. The HTML section
 * page sits behind a Cloudflare challenge; this JSON does not, needs no
 * session, and carries every article's body inline.
 */
export const KITCHEN_NUTRITION_API_URL =
  'https://help.goodeggs.com/api/v2/help_center/en-us/sections/360007686892/articles.json?per_page=100';

const IMAGE_HOST = 'https://images.goodeggs.com';
/** Cloudflare Image Resizing prefix every Good Eggs product photo is served through. */
const RESIZE_PREFIX = `${IMAGE_HOST}/cdn-cgi/image/`;
/**
 * The rendition handed to a caller: no crop (the page's own 840x525 crop can cut
 * a label off), capped at 2000px wide, JPEG. The uncropped original can be
 * several megabytes, so it is offered separately.
 */
const READABLE_RENDITION = 'width=2000,fit=scale-down,format=jpeg,quality=85';

/** A nutrient value exactly as the table states it. */
export type NutrientValue = number | string | null;

export interface NutritionFacts {
  /** Servings per package. Null when the table has no such column. */
  servingsPerPackage: NutrientValue;
  /** Serving size as printed, e.g. "85 gr". */
  servingSize: NutrientValue;
  calories: NutrientValue;
  totalFatG: NutrientValue;
  saturatedFatG: NutrientValue;
  transFatG: NutrientValue;
  cholesterolMg: NutrientValue;
  sodiumMg: NutrientValue;
  totalCarbohydrateG: NutrientValue;
  dietaryFiberG: NutrientValue;
  totalSugarsG: NutrientValue;
  addedSugarsG: NutrientValue;
  proteinG: NutrientValue;
  vitaminDMcg: NutrientValue;
  calciumMg: NutrientValue;
  ironMg: NutrientValue;
  potassiumMg: NutrientValue;
}

/** Table header → field. A header not listed here is ignored, not guessed at. */
const COLUMN_FIELDS: Record<string, keyof NutritionFacts> = {
  'servings per package': 'servingsPerPackage',
  'serving size': 'servingSize',
  calories: 'calories',
  'total fat (g)': 'totalFatG',
  'saturated fat (g)': 'saturatedFatG',
  'trans fat (g)': 'transFatG',
  'cholesterol (mg)': 'cholesterolMg',
  'sodium (mg)': 'sodiumMg',
  'total carbohydrate (g)': 'totalCarbohydrateG',
  'dietary fiber (g)': 'dietaryFiberG',
  'total sugars (g)': 'totalSugarsG',
  'added sugars (g)': 'addedSugarsG',
  'protein (g)': 'proteinG',
  'vitamin d (mcg)': 'vitaminDMcg',
  'calcium (mg)': 'calciumMg',
  'iron (mg)': 'ironMg',
  'potassium (mg)': 'potassiumMg',
};

const NAME_HEADER = 'recipe name';

/** One row of a kitchen nutrition table, with where it came from. */
export interface KitchenNutritionRow {
  /** The row's name cell verbatim, e.g. "Black Beans - 10 oz". */
  recipeName: string;
  facts: NutritionFacts;
  articleTitle: string;
  articleUrl: string;
  /** When Good Eggs last edited the article — the data is only as fresh as this. */
  articleUpdatedAt?: string;
}

interface ZendeskArticle {
  title?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
  body?: unknown;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A plain number becomes a number; anything else ("less than 1", "28 gr") stays as printed. */
export function parseCell(text: string): NutrientValue {
  if (text === '') return null;
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

function emptyFacts(): NutritionFacts {
  return {
    servingsPerPackage: null,
    servingSize: null,
    calories: null,
    totalFatG: null,
    saturatedFatG: null,
    transFatG: null,
    cholesterolMg: null,
    sodiumMg: null,
    totalCarbohydrateG: null,
    dietaryFiberG: null,
    totalSugarsG: null,
    addedSugarsG: null,
    proteinG: null,
    vitaminDMcg: null,
    calciumMg: null,
    ironMg: null,
    potassiumMg: null,
  };
}

/**
 * Parse the Help Center API response into rows.
 *
 * Columns are mapped by HEADER TEXT, not position: one article in the section
 * has no "Servings per Package" column, and positional parsing would shift every
 * value after it one place left — calories read as serving size, fat as calories.
 *
 * Throws when the response is not the shape it should be, or yields no rows at
 * all: a section that parses to nothing is a shape change, and reporting it as
 * "no row for this product" would be a confident wrong answer.
 */
export function parseKitchenNutritionArticles(json: unknown): KitchenNutritionRow[] {
  const articles = (json as { articles?: unknown } | null)?.articles;
  if (!Array.isArray(articles)) {
    throw new Error('the help-center response carried no articles array');
  }
  const rows: KitchenNutritionRow[] = [];
  for (const raw of articles as ZendeskArticle[]) {
    if (typeof raw?.body !== 'string') continue;
    const articleTitle = typeof raw.title === 'string' ? raw.title : '';
    const articleUrl =
      typeof raw.html_url === 'string' ? raw.html_url : KITCHEN_NUTRITION_SECTION_URL;
    const articleUpdatedAt = typeof raw.updated_at === 'string' ? raw.updated_at : undefined;

    let columns: (keyof NutritionFacts | typeof NAME_HEADER | null)[] | null = null;
    for (const tr of raw.body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        cellText(c[1]),
      );
      if (cells.length === 0) continue;
      if (cells[0].toLowerCase() === NAME_HEADER) {
        columns = cells.map((h) => {
          const key = h.toLowerCase();
          return key === NAME_HEADER ? NAME_HEADER : (COLUMN_FIELDS[key] ?? null);
        });
        continue;
      }
      if (!columns || !cells[0]) continue;
      const facts = emptyFacts();
      cells.forEach((text, i) => {
        const field = columns![i];
        if (field && field !== NAME_HEADER) facts[field] = parseCell(text);
      });
      rows.push({ recipeName: cells[0], facts, articleTitle, articleUrl, articleUpdatedAt });
    }
  }
  if (rows.length === 0) {
    throw new Error('the help-center articles parsed to zero nutrition rows');
  }
  return rows;
}

/** Fold a product or recipe name to a comparison key. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Split "Black Beans - 10 oz" / "Chicken Tenders-16oz" into a name and a size label. */
export function splitRecipeName(recipeName: string): { base: string; size?: string } {
  const m = recipeName.match(/^(.*?)(?:\s+-\s+|\s*-(?=\s*\d))(.*)$/);
  if (!m) return { base: recipeName.trim() };
  return { base: m[1].trim(), size: m[2].trim() || undefined };
}

function sizeKey(size: string | undefined): string {
  return (size ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9.]/g, '');
}

const dropParenthetical = (s: string) => s.replace(/\s*\(.*?\)\s*/g, ' ').trim();

export type KitchenMatch =
  | { kind: 'found'; row: KitchenNutritionRow; sizeMatches: boolean }
  | { kind: 'ambiguous'; rows: KitchenNutritionRow[] }
  | { kind: 'no_row' };

/**
 * Find a product's row. The match is on the WHOLE name, after folding case,
 * punctuation and accents — never a substring or a "closest" row, because a
 * near-miss here is another product's macros reported as this one's. A
 * parenthetical such as "(Frozen)" is dropped and tried once more.
 *
 * Several rows under one name are told apart by the product's retail units;
 * when that does not leave exactly one, every candidate is returned and the
 * caller is told it is ambiguous.
 */
export function matchKitchenRow(
  productName: string,
  retailUnits: string | undefined,
  rows: KitchenNutritionRow[],
): KitchenMatch {
  const tryKey = (key: string) =>
    rows.filter((r) => normalizeName(splitRecipeName(r.recipeName).base) === key);

  let candidates = tryKey(normalizeName(productName));
  if (candidates.length === 0) {
    const stripped = normalizeName(dropParenthetical(productName));
    candidates = rows.filter(
      (r) => normalizeName(dropParenthetical(splitRecipeName(r.recipeName).base)) === stripped,
    );
  }

  // The same row can appear in two articles; identical facts are one row.
  const unique: KitchenNutritionRow[] = [];
  for (const c of candidates) {
    if (!unique.some((u) => JSON.stringify(u.facts) === JSON.stringify(c.facts))) unique.push(c);
  }
  if (unique.length === 0) return { kind: 'no_row' };

  const units = sizeKey(retailUnits);
  const sizeMatches = (r: KitchenNutritionRow) =>
    units !== '' && sizeKey(splitRecipeName(r.recipeName).size) === units;

  if (unique.length === 1)
    return { kind: 'found', row: unique[0], sizeMatches: sizeMatches(unique[0]) };
  const bySize = unique.filter(sizeMatches);
  if (bySize.length === 1) return { kind: 'found', row: bySize[0], sizeMatches: true };
  return { kind: 'ambiguous', rows: unique };
}

/** A source of kitchen nutrition rows. Injected so tests never touch the network. */
export interface KitchenNutritionSource {
  getRows(): Promise<KitchenNutritionRow[]>;
}

export interface HttpKitchenNutritionSourceOptions {
  fetchImpl?: typeof fetch;
  /** How long a successful read is reused. Failures are never cached. */
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Reads the section over HTTPS and keeps a good read for `ttlMs` (6 hours by
 * default — the articles change a few times a year). Pages are followed through
 * `next_page`, up to five.
 */
export class HttpKitchenNutritionSource implements KitchenNutritionSource {
  private cache: { rows: KitchenNutritionRow[]; at: number } | null = null;
  private inFlight: Promise<KitchenNutritionRow[]> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: HttpKitchenNutritionSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  async getRows(): Promise<KitchenNutritionRow[]> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.rows;
    if (!this.inFlight) {
      this.inFlight = this.load()
        .then((rows) => {
          this.cache = { rows, at: this.now() };
          return rows;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async load(): Promise<KitchenNutritionRow[]> {
    const articles: unknown[] = [];
    let url: string | null = KITCHEN_NUTRITION_API_URL;
    for (let page = 0; url && page < 5; page++) {
      const res = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (strad good-eggs)' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`the help center answered HTTP ${res.status}`);
      const json = (await res.json()) as { articles?: unknown; next_page?: unknown };
      if (!Array.isArray(json?.articles)) {
        throw new Error('the help-center response carried no articles array');
      }
      articles.push(...json.articles);
      url = typeof json.next_page === 'string' ? json.next_page : null;
    }
    return parseKitchenNutritionArticles({ articles });
  }
}

let defaultSource: KitchenNutritionSource = new HttpKitchenNutritionSource();

/** Swap the kitchen-table source (tests); null restores the HTTPS default. */
export function setKitchenNutritionSource(source: KitchenNutritionSource | null): void {
  defaultSource = source ?? new HttpKitchenNutritionSource();
}

export function getKitchenNutritionSource(): KitchenNutritionSource {
  return defaultSource;
}

export interface ProductImage {
  /** Uncropped, at most 2000px wide, JPEG. Fetchable without a session. */
  url: string;
  /** The uploaded original at full resolution — can be several MB. */
  originalUrl: string;
  alt?: string;
}

/**
 * Turn a page photo URL into the two renditions handed to a caller. A URL that
 * is not on Good Eggs' image CDN is passed through as both, untouched.
 */
export function productImageFromUrl(photoUrl: string, alt?: string): ProductImage {
  if (photoUrl.startsWith(RESIZE_PREFIX)) {
    const rest = photoUrl.slice(RESIZE_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) {
      const path = rest.slice(slash + 1);
      return {
        url: `${RESIZE_PREFIX}${READABLE_RENDITION}/${path}`,
        originalUrl: `${IMAGE_HOST}/${path}`,
        ...(alt ? { alt } : {}),
      };
    }
  }
  return { url: photoUrl, originalUrl: photoUrl, ...(alt ? { alt } : {}) };
}

export type NutritionStatus =
  'found' | 'ambiguous' | 'not_in_kitchen_tables' | 'not_published' | 'unknown';

export interface KitchenRowView {
  recipeName: string;
  facts: NutritionFacts;
  source: { title: string; url: string; updatedAt?: string };
}

export interface GroceryNutrition {
  url: string;
  productId?: string;
  name: string;
  producer?: string;
  producerSlug?: string;
  retailUnits?: string;
  productType?: string;
  nutrition: {
    status: NutritionStatus;
    /** One sentence saying what the status means for THIS product. */
    note: string;
    /** Present when status is `found`. */
    facts?: NutritionFacts;
    matchedRow?: KitchenRowView;
    /** False when the matched row is for a different package size than this product. */
    sizeMatches?: boolean;
    /** Present when status is `ambiguous`. */
    candidates?: KitchenRowView[];
  };
  images: ProductImage[];
  imagesNote: string;
}

interface ProductDetailsPayload {
  product?: {
    id?: string;
    name?: string;
    url?: string;
    retailUnits?: string;
    productType?: string;
    photoUrl?: string;
    currentProducer?: { name?: string; slug?: string } | null;
    vendor?: { name?: string; slug?: string } | null;
  } | null;
  photoUrl?: string;
  photosUrls?: { url?: string; alt?: string }[] | null;
}

const rowView = (r: KitchenNutritionRow): KitchenRowView => ({
  recipeName: r.recipeName,
  facts: r.facts,
  source: { title: r.articleTitle, url: r.articleUrl, updatedAt: r.articleUpdatedAt },
});

const IMAGES_NOTE =
  'Public CDN URLs: fetch them without a session (e.g. `curl -sSLo label.jpg "<url>"`). ' +
  'They are Good Eggs product photography, usually the FRONT of the pack — a Nutrition ' +
  'Facts panel is legible only if the photo happens to show it.';

/**
 * Build the nutrition answer from a product page's served HTML.
 *
 * Throws when the page carries no product payload: without it neither the
 * product, its producer nor its photos are known, and an empty answer would
 * read as "this product has no images and no nutrition".
 */
export async function groceryNutritionFromHtml(
  html: string,
  groceryUrl: string,
  source: KitchenNutritionSource,
  expectedProductId?: string,
): Promise<GroceryNutrition> {
  const storeData = extractStoreData(html) as
    | (ReturnType<typeof extractStoreData> & { productDetails?: ProductDetailsPayload | null })
    | null;
  const details = storeData?.productDetails;
  const product = details?.product;
  if (!product || !product.name) {
    throw new Error(
      'the product page carried no product payload (storeData.productDetails.product). ' +
        'The URL may not be a product page, or the page shape changed; nutrition and ' +
        'images are UNKNOWN, not absent.',
    );
  }
  if (expectedProductId && product.id && product.id !== expectedProductId) {
    throw new Error(
      `the page served product ${product.id}, not the requested ${expectedProductId} ` +
        "(a redirect?); refusing to report another product's nutrition.",
    );
  }

  const producer = product.currentProducer ?? product.vendor ?? undefined;
  const producerSlug = producer?.slug;

  const photos = (details?.photosUrls ?? []).filter(
    (p): p is { url: string; alt?: string } => typeof p?.url === 'string' && p.url !== '',
  );
  const photoUrls =
    photos.length > 0
      ? photos
      : [details?.photoUrl ?? product.photoUrl]
          .filter((u): u is string => typeof u === 'string' && u !== '')
          .map((url) => ({ url, alt: undefined }));
  const images = photoUrls.map((p) => productImageFromUrl(p.url, p.alt));

  const base: Omit<GroceryNutrition, 'nutrition'> = {
    url: groceryUrl,
    ...(product.id ? { productId: product.id } : {}),
    name: product.name,
    ...(producer?.name ? { producer: producer.name } : {}),
    ...(producerSlug ? { producerSlug } : {}),
    ...(product.retailUnits ? { retailUnits: product.retailUnits } : {}),
    ...(product.productType ? { productType: product.productType } : {}),
    images,
    imagesNote: images.length > 0 ? IMAGES_NOTE : 'Good Eggs serves no photo for this product.',
  };

  if (producerSlug !== KITCHEN_PRODUCER_SLUG) {
    return {
      ...base,
      nutrition: {
        status: 'not_published',
        note:
          'Good Eggs publishes no nutrition facts for this product — only its own kitchen ' +
          '(producer "goodeggskitchen") has nutrition tables. Read the label from the images ' +
          'if one shows it, or look the product up by producer, name and retail units in a ' +
          'nutrition database.',
      },
    };
  }

  let rows: KitchenNutritionRow[];
  try {
    rows = await source.getRows();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      nutrition: {
        status: 'unknown',
        note:
          `This is a Good Eggs Kitchen product, but its nutrition tables could not be read ` +
          `(${reason}). Its nutrition is UNKNOWN, not absent — retry, or read ` +
          `${KITCHEN_NUTRITION_SECTION_URL}.`,
      },
    };
  }

  const match = matchKitchenRow(product.name, product.retailUnits, rows);
  if (match.kind === 'found') {
    const view = rowView(match.row);
    return {
      ...base,
      nutrition: {
        status: 'found',
        note: match.sizeMatches
          ? `From Good Eggs Kitchen's published table "${view.source.title}".`
          : `From Good Eggs Kitchen's published table "${view.source.title}", row ` +
            `"${view.recipeName}" — whose size label does not match this product's retail ` +
            `units (${product.retailUnits ?? 'none given'}). Per-serving values hold; ` +
            'servings per package may not.',
        facts: match.row.facts,
        matchedRow: view,
        sizeMatches: match.sizeMatches,
      },
    };
  }
  if (match.kind === 'ambiguous') {
    return {
      ...base,
      nutrition: {
        status: 'ambiguous',
        note:
          `Good Eggs Kitchen's tables have ${match.rows.length} different rows under this ` +
          'name and none is singled out by the retail units. Each is listed; pick by size.',
        candidates: match.rows.map(rowView),
      },
    };
  }
  return {
    ...base,
    nutrition: {
      status: 'not_in_kitchen_tables',
      note:
        `Good Eggs Kitchen product, but none of the ${rows.length} rows in its published ` +
        'nutrition tables carries this name (the tables are not kept current with the ' +
        'catalog). Good Eggs publishes nothing else for it.',
    },
  };
}

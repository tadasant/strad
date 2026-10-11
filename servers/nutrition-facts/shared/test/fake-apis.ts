/**
 * Fake FatSecret and FoodData Central, as one `fetch`. Shapes are taken from
 * the published docs (FatSecret foods.search v1 and food.get v5; FDC
 * /foods/search and /food/{id}), including FatSecret's quirks: every number a
 * string, HTTP 200 for API errors, and a single result as an object rather
 * than a one-element array.
 */

import type { ProxiedFetch } from "../src/remote/fatsecret.js";

export const TOKEN_URL = "https://oauth.fatsecret.test/connect/token";
export const FS_API = "https://platform.fatsecret.test/rest";
export const FDC_API = "https://api.fdc.test/fdc/v1";

export const PROXY_PASSWORD = "proxy-pass-5f3a9c";
export const PROXY_URL = `http://brd-customer-hl_test-zone-fatsecret:${PROXY_PASSWORD}@proxy.test:33335`;

export const FS_CREDENTIALS = {
  FATSECRET_CLIENT_ID: "client-id-0123456789",
  FATSECRET_CLIENT_SECRET: "client-secret-0123456789",
  FATSECRET_PROXY_URL: PROXY_URL,
};

interface FsFood {
  food_id: string;
  food_name: string;
  food_type: "Brand" | "Generic";
  brand_name?: string;
  description: string;
  servings: Array<Record<string, string>>;
}

export const FS_FOODS: FsFood[] = [
  {
    food_id: "41963",
    food_name: "Big Mac",
    food_type: "Brand",
    brand_name: "McDonald's",
    description: "Per 1 burger - Calories: 590kcal | Fat: 34.00g | Carbs: 46.00g | Protein: 25.00g",
    servings: [
      {
        serving_id: "11",
        serving_description: "1 burger",
        metric_serving_amount: "219.000",
        metric_serving_unit: "g",
        number_of_units: "1.000",
        measurement_description: "serving",
        calories: "590",
        carbohydrate: "46.00",
        protein: "25.00",
        fat: "34.00",
        saturated_fat: "11.000",
        sodium: "1050",
        fiber: "3.0",
        sugar: "9.00",
      },
    ],
  },
  {
    food_id: "4501",
    food_name: "White Rice",
    food_type: "Generic",
    description: "Per 1 cup - Calories: 260kcal | Fat: 0.50g | Carbs: 56.00g | Protein: 5.00g",
    servings: [
      {
        serving_id: "21",
        serving_description: "1 cup",
        metric_serving_amount: "158.000",
        metric_serving_unit: "g",
        number_of_units: "1.000",
        measurement_description: "cup",
        calories: "260",
        carbohydrate: "56.00",
        protein: "5.00",
        fat: "0.50",
        sodium: "2",
      },
      {
        serving_id: "22",
        serving_description: "100 g",
        metric_serving_amount: "100.000",
        metric_serving_unit: "g",
        number_of_units: "100.000",
        measurement_description: "g",
        calories: "165",
        carbohydrate: "35.40",
        protein: "3.20",
        fat: "0.30",
        sodium: "1",
      },
    ],
  },
];

export interface FakeOptions {
  /** FatSecret error code to answer every API call with (HTTP 200). */
  fsError?: number;
  /** Answer the first API call with error 13 (invalid token). */
  expireTokenOnce?: boolean;
  /** Reject the client credentials at the token endpoint. */
  badClient?: boolean;
}

export class FakeApis {
  readonly calls: string[] = [];
  /** The dispatcher every FatSecret request was sent with, in order. */
  readonly dispatchers: unknown[] = [];
  tokenRequests = 0;
  apiCalls = 0;
  fdcCalls = 0;
  private expired = false;

  constructor(private readonly options: FakeOptions = {}) {}

  get fsCalls(): string[] {
    return this.calls.filter((c) => c.startsWith(FS_API));
  }

  /** FatSecret's transport: records the dispatcher, then answers like `fetch`. */
  readonly fatsecretFetch: ProxiedFetch = async (url, init) => {
    this.dispatchers.push(init.dispatcher);
    return this.fetch(url, init as RequestInit);
  };

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.calls.push(url);
    if (url === TOKEN_URL) return this.token(init);
    if (url.startsWith(FS_API)) return this.fatsecret(new URL(url), init);
    if (url.startsWith(FDC_API)) return this.fdc(new URL(url));
    throw new Error(`unexpected fetch ${url}`);
  };

  private token(init: RequestInit | undefined): Response {
    this.tokenRequests += 1;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const expected = `Basic ${Buffer.from(
      `${FS_CREDENTIALS.FATSECRET_CLIENT_ID}:${FS_CREDENTIALS.FATSECRET_CLIENT_SECRET}`,
    ).toString("base64")}`;
    if (this.options.badClient || auth !== expected || !String(init?.body).includes("scope=basic")) {
      return json({ error: "invalid_client" }, 400);
    }
    return json({ access_token: `token-${this.tokenRequests}`, token_type: "Bearer", expires_in: 86400 });
  }

  private fatsecret(url: URL, init: RequestInit | undefined): Response {
    this.apiCalls += 1;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!auth.startsWith("Bearer token-")) {
      return json({ error: { code: 13, message: "Invalid token" } });
    }
    if (this.options.expireTokenOnce && !this.expired) {
      this.expired = true;
      return json({ error: { code: 13, message: "Invalid token: expired" } });
    }
    if (this.options.fsError) {
      return json({ error: { code: this.options.fsError, message: "fake error" } });
    }
    if (url.searchParams.get("format") !== "json") return new Response("<xml/>", { status: 200 });
    if (url.pathname.endsWith("/foods/search/v1")) {
      const words = (url.searchParams.get("search_expression") ?? "").toLowerCase().split(/\W+/).filter(Boolean);
      const hits = FS_FOODS.filter((f) =>
        words.some((w) => w.length > 2 && `${f.brand_name ?? ""} ${f.food_name}`.toLowerCase().includes(w)),
      ).map((f) => ({
        food_id: f.food_id,
        food_name: f.food_name,
        food_type: f.food_type,
        ...(f.brand_name ? { brand_name: f.brand_name } : {}),
        food_description: f.description,
        food_url: `https://foods.fatsecret.com/calories-nutrition/${f.food_id}`,
      }));
      // FatSecret's quirk: one result is an object, not an array.
      const food = hits.length === 1 ? hits[0] : hits;
      return json({
        foods: { food, max_results: "10", page_number: "0", total_results: String(hits.length) },
      });
    }
    if (url.pathname.endsWith("/food/v5")) {
      const f = FS_FOODS.find((x) => x.food_id === url.searchParams.get("food_id"));
      if (!f) return json({ error: { code: 106, message: "Invalid ID" } });
      return json({
        food: {
          food_id: f.food_id,
          food_name: f.food_name,
          food_type: f.food_type,
          ...(f.brand_name ? { brand_name: f.brand_name } : {}),
          food_url: `https://foods.fatsecret.com/calories-nutrition/${f.food_id}`,
          servings: { serving: f.servings.length === 1 ? f.servings[0] : f.servings },
        },
      });
    }
    return json({ error: { code: 23, message: "Api not found" } });
  }

  private fdc(url: URL): Response {
    this.fdcCalls += 1;
    if (url.searchParams.get("api_key") !== "fdc-key") return new Response("forbidden", { status: 403 });
    const branded = {
      fdcId: 9001,
      description: "GREEK NONFAT YOGURT, PLAIN",
      dataType: "Branded",
      brandOwner: "Chobani, LLC",
      brandName: "CHOBANI",
      servingSize: 170,
      servingSizeUnit: "g",
      householdServingFullText: "1 container",
      publishedDate: "2025-11-20",
      foodNutrients: [
        { nutrientNumber: "208", value: 53 },
        { nutrientNumber: "203", value: 9.41 },
        { nutrientNumber: "205", value: 3.53 },
        { nutrientNumber: "204", value: 0 },
        { nutrientNumber: "269", value: 2.35 },
        { nutrientNumber: "307", value: 35 },
      ],
    };
    if (url.pathname.endsWith("/foods/search")) {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      return json({ foods: q.includes("yogurt") || q.includes("chobani") ? [branded] : [] });
    }
    if (url.pathname.endsWith("/food/9001")) {
      return json({
        ...branded,
        foodNutrients: branded.foodNutrients.map((n) => ({ nutrient: { number: n.nutrientNumber }, amount: n.value })),
      });
    }
    return new Response("not found", { status: 404 });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

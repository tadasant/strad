import { z } from 'zod';

// =============================================================================
// Good Eggs Data Types
// =============================================================================

export interface GroceryItem {
  url: string;
  name: string;
  brand: string;
  price: string;
  originalPrice?: string;
  discount?: string;
  unit?: string;
  imageUrl?: string;
  quantity?: string;
  quantityOrdered?: number;
  isFavorite?: boolean;
}

export interface CartItem {
  url: string;
  name: string;
  brand: string;
  price: string;
  unit?: string;
  quantity: number;
  imageUrl?: string;
  /**
   * The stable Good Eggs product id. Read straight off the basket payload, so
   * it is present even when the product's presentation data is not — which
   * makes it the join key `remove_from_cart` matches on.
   */
  productId?: string;
  /** Whether the line is a Subscribe & Save line. A basket update sends it back. */
  subscribed?: boolean;
}

export interface GroceryDetails {
  url: string;
  name: string;
  brand: string;
  price: string;
  originalPrice?: string;
  discount?: string;
  unit?: string;
  description?: string;
  productDetails?: string;
  availability?: string[];
  imageUrl?: string;
}

export interface PastOrder {
  /** How Good Eggs names the delivery day, e.g. "Monday, September 21st". */
  date: string;
  /** The delivery day as YYYY-MM-DD, in the foodhub's timezone. */
  isoDate?: string;
  orderId?: string;
  total?: string;
  itemCount?: number;
  deliveryStatus?: string;
}

export interface CartResult {
  success: boolean;
  message: string;
  itemName?: string;
  quantity?: number;
  /**
   * Whether the outcome was confirmed against the basket. False means the
   * basket could not be read, so the message describes what was ATTEMPTED and
   * the caller must not infer either outcome from it.
   */
  verified?: boolean;
}

// =============================================================================
// Tool Input Schemas
// =============================================================================

export const SearchGrocerySchema = z.object({
  query: z
    .string()
    .describe('Search query for groceries (e.g., "organic apples", "milk", "bread")'),
});

const goodEggsUrlSchema = z
  .string()
  .url()
  .refine((url) => url.startsWith('https://www.goodeggs.com/'), {
    message: 'URL must be a Good Eggs URL (https://www.goodeggs.com/...)',
  });

export const GetGroceryDetailsSchema = z.object({
  grocery_url: goodEggsUrlSchema.describe(
    'The Good Eggs URL of the grocery item to get details for'
  ),
});

export const GetGroceryNutritionSchema = z.object({
  grocery_url: goodEggsUrlSchema.describe(
    'The Good Eggs product URL to get nutrition and photo URLs for'
  ),
});

export const AddToCartSchema = z.object({
  grocery_url: goodEggsUrlSchema.describe('The Good Eggs URL of the grocery item to add to cart'),
  quantity: z
    .number()
    .int('Quantity must be a whole number')
    .min(1)
    .max(99, 'Quantity cannot exceed 99')
    .optional()
    .default(1)
    .describe('How many of this item the cart should hold (minimum 1, maximum 99, default: 1)'),
});

export const GetPastOrderGroceriesSchema = z.object({
  past_order_date: z
    .string()
    .describe(
      'The delivery date of the past order, e.g. "2026-09-21", "9/21" or "Monday, September 21st"'
    ),
});

export const AddFavoriteSchema = z.object({
  grocery_url: goodEggsUrlSchema.describe(
    'The Good Eggs URL of the grocery item to add to favorites'
  ),
});

export const RemoveFavoriteSchema = z.object({
  grocery_url: goodEggsUrlSchema.describe(
    'The Good Eggs URL of the grocery item to remove from favorites'
  ),
});

export const RemoveFromCartSchema = z.object({
  grocery_url: goodEggsUrlSchema.describe(
    'The Good Eggs URL of the grocery item to remove from cart'
  ),
});

// =============================================================================
// Playwright Configuration
// =============================================================================

export interface GoodEggsConfig {
  username: string;
  password: string;
  headless: boolean;
  timeout: number;
}

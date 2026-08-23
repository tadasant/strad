import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ClientFactory, IGoodEggsClient } from './server.js';
import { formatCents } from './basketState.js';
import {
  SEARCH_APP_URI,
  SEARCH_APP_NAME,
  SEARCH_APP_MIME,
  SEARCH_APP_TOOL,
  searchAppToolMeta,
  renderSearchAppHtml,
} from './appUi.js';
import {
  SearchGrocerySchema,
  GetGroceryDetailsSchema,
  AddToCartSchema,
  GetPastOrderGroceriesSchema,
  AddFavoriteSchema,
  RemoveFavoriteSchema,
  RemoveFromCartSchema,
} from './types.js';

// =============================================================================
// TOOL DESCRIPTIONS
// =============================================================================

const SEARCH_GROCERY_DESCRIPTION = `Search for groceries on Good Eggs.

Returns a list of grocery items matching your search query, including:
- Product URL (for use with other tools)
- Product name and brand
- Price information
- Any discounts/deals
- Whether the item is in your favorites

**Example queries:**
- "organic apples"
- "milk"
- "chicken breast"
- "gluten free bread"`;

const GET_FAVORITES_DESCRIPTION = `Get the user's favorite/saved grocery items on Good Eggs.

Returns a list of all items the user has marked as favorites, including:
- Product URL (for use with other tools)
- Product name and brand
- Price information

Requires the user to be logged in.`;

const GET_GROCERY_DETAILS_DESCRIPTION = `Get detailed information about a specific grocery item.

Provide the Good Eggs URL of the item (from search results or favorites).
Returns comprehensive details including:
- Full product name and brand
- Current and original prices
- Product description
- Delivery availability dates

**Tip:** This tool checks if you're already on the product page to minimize navigation.`;

const ADD_TO_CART_DESCRIPTION = `Add a grocery item to your shopping cart.

Provide:
- grocery_url: The Good Eggs URL of the item to add
- quantity: Number of items to add (default: 1)

Returns confirmation of the item added and the resulting cart quantity. After
attempting the add, the basket is re-read to verify the item actually landed, so
the result reflects the true basket state rather than just whether a button was
clicked. Possible outcomes: a confirmed add, a partial add (cart quantity below
what was requested), a genuine failure (e.g. a delivery day still needs to be
selected), or an UNVERIFIED result.

An UNVERIFIED result means the basket could not be read back, so the outcome is
unknown. Do not retry a blind add on one — read the cart first, or you will
create duplicates.

**Tip:** This tool checks if you're already on the product page to minimize navigation.`;

const SEARCH_FREEBIE_GROCERIES_DESCRIPTION = `Search for free items ($0.00) on Good Eggs.

Checks the homepage and /fresh-picks page for items priced at $0.00.
These are typically promotional freebies offered by Good Eggs.

Returns a list of free items with their URLs for adding to cart.`;

const GET_PAST_ORDER_DATES_DESCRIPTION = `Get a list of past order dates from Good Eggs.

Returns a list of previous orders with:
- Order date
- Order total (if available)
- Number of items (if available)

Use these dates with get_past_order_groceries to see specific order contents.
Requires the user to be logged in.`;

const GET_PAST_ORDER_GROCERIES_DESCRIPTION = `Get the grocery items from a specific past order.

Provide the past_order_date (from get_list_of_past_order_dates) to see what was ordered.
Returns a list of items from that order including:
- Product URL
- Product name and brand
- Quantity ordered (e.g., 2 if you ordered 2 of something)
- Unit of sale (e.g., "1 bunch", "1 lb", "15 oz")
- Price at time of order

Useful for reordering frequently purchased items.
Requires the user to be logged in.`;

const ADD_FAVORITE_DESCRIPTION = `Add a grocery item to your favorites.

Provide the Good Eggs URL of the item to add to favorites.
If the item is already in favorites, it will let you know.

Returns confirmation of the action taken.`;

const REMOVE_FAVORITE_DESCRIPTION = `Remove a grocery item from your favorites.

Provide the Good Eggs URL of the item to remove from favorites.
If the item is not in favorites, it will let you know.

Returns confirmation of the action taken.`;

const REMOVE_FROM_CART_DESCRIPTION = `Remove a grocery item from your shopping cart.

Provide the Good Eggs URL of the item to remove from your cart.

Whether the item is in the cart is decided against the basket state Good Eggs
renders into the page, not against the drawn markup, so "item not found in cart"
means the basket really does not contain it. The removal itself is then verified
by re-reading the basket.

Returns confirmation of the removal, "item not found in cart", a failure if the
item is still present afterward, or an UNVERIFIED result if the basket could not
be read (in which case the outcome is unknown — read the cart before retrying).`;

const GET_CART_DESCRIPTION = `Get the contents of your Good Eggs shopping cart.

Returns a list of all items currently in your cart, including:
- Product URL (for use with other tools)
- Product name and brand
- Quantity in cart
- Unit size (e.g., "6 count", "24 oz")
- The line subtotal (quantity x unit price), labelled "Line subtotal"
plus the basket subtotal.

The read comes from the basket state Good Eggs renders into the page, not from
the drawn markup, so it does not depend on which basket layout the account is
served.

If the basket cannot be read — including when the login has lapsed, where the
page serves a readable but ANONYMOUS basket — this tool returns an ERROR. It
never answers an unreadable basket with "your cart is empty": treat an error as
"unknown", not as "empty", and do not infer that the user removed anything.`;

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    // Machine-readable mirror of the result, attached only for MCP-App clients
    // so the inline UI can paint from structured data instead of re-parsing text.
    structuredContent?: Record<string, unknown>;
  }>;
}

/**
 * Async getter that returns a ready-to-use client (login completed)
 */
export type GetReadyClientFn = () => Promise<IGoodEggsClient>;

/**
 * Options for tool registration.
 */
export interface RegisterToolsOptions {
  /**
   * The client advertised the `io.modelcontextprotocol/ui` extension, so this
   * connection gets the MCP-App surface: the `ui://good-eggs/search-results`
   * resource, the `_meta` binding on `search_for_grocery`, and structured
   * result data. When false (the default), every response is byte-identical to
   * the plain, pre-App tool surface.
   */
  appUi?: boolean;
}

export function createRegisterTools(
  clientFactory: ClientFactory,
  getReadyClient?: GetReadyClientFn,
  options: RegisterToolsOptions = {}
) {
  const appUi = options.appUi === true;
  // Create a single client instance that persists across calls
  let client: IGoodEggsClient | null = null;
  let isInitialized = false;

  // If getReadyClient is provided (background login mode), use it
  // Otherwise fall back to lazy initialization (legacy behavior)
  const getClient = async (): Promise<IGoodEggsClient> => {
    if (getReadyClient) {
      // Use the provided getter that handles background login
      return getReadyClient();
    }

    // Legacy behavior: lazy initialization
    if (!client) {
      client = clientFactory();
    }
    if (!isInitialized) {
      await client.initialize();
      isInitialized = true;
    }
    return client;
  };

  const tools: Tool[] = [
    {
      name: 'search_for_grocery',
      description: SEARCH_GROCERY_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Search query for groceries (e.g., "organic apples", "milk", "bread")',
          },
        },
        required: ['query'],
      },
      handler: async (args: unknown) => {
        try {
          const validated = SearchGrocerySchema.parse(args);
          const goodEggsClient = await getClient();
          const results = await goodEggsClient.searchGroceries(validated.query);

          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No groceries found for "${validated.query}". Try a different search term.`,
                },
              ],
              // MCP-App clients get the structured mirror even when empty, so the
              // inline grid can render its "no products" state.
              ...(appUi ? { structuredContent: { query: validated.query, products: [] } } : {}),
            };
          }

          const formattedResults = results
            .map(
              (item, i) =>
                `${i + 1}. **${item.name}**${item.isFavorite ? ' ❤️' : ''}\n   Brand: ${item.brand || 'N/A'}\n   Price: ${item.price || 'N/A'}${item.discount ? `\n   Discount: ${item.discount}` : ''}${item.isFavorite !== undefined ? `\n   Favorite: ${item.isFavorite ? 'Yes' : 'No'}` : ''}\n   URL: ${item.url}`
            )
            .join('\n\n');

          return {
            content: [
              {
                type: 'text',
                text: `Found ${results.length} groceries for "${validated.query}":\n\n${formattedResults}`,
              },
            ],
            // The text block above is unchanged for every client. For MCP-App
            // clients we ADD a structured mirror the inline UI paints from — the
            // richer product fields (imageUrl, discount, favorite) that the text
            // summary flattens away.
            ...(appUi ? { structuredContent: { query: validated.query, products: results } } : {}),
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error searching for groceries: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'get_favorites',
      description: GET_FAVORITES_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      handler: async () => {
        try {
          const goodEggsClient = await getClient();
          const results = await goodEggsClient.getFavorites();

          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No favorite items found. Add items to your favorites on Good Eggs to see them here.',
                },
              ],
            };
          }

          const formattedResults = results
            .map(
              (item, i) =>
                `${i + 1}. **${item.name}**\n   Brand: ${item.brand || 'N/A'}\n   Price: ${item.price || 'N/A'}\n   URL: ${item.url}`
            )
            .join('\n\n');

          return {
            content: [
              {
                type: 'text',
                text: `Found ${results.length} favorite items:\n\n${formattedResults}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error getting favorites: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'get_grocery_details',
      description: GET_GROCERY_DETAILS_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          grocery_url: {
            type: 'string',
            description: 'The Good Eggs URL of the grocery item to get details for',
          },
        },
        required: ['grocery_url'],
      },
      handler: async (args: unknown) => {
        try {
          const validated = GetGroceryDetailsSchema.parse(args);
          const goodEggsClient = await getClient();
          const details = await goodEggsClient.getGroceryDetails(validated.grocery_url);

          const lines = [
            `**${details.name}**`,
            `Brand: ${details.brand || 'N/A'}`,
            `Price: ${details.price || 'N/A'}`,
          ];

          if (details.originalPrice) {
            lines.push(`Original Price: ${details.originalPrice}`);
          }
          if (details.discount) {
            lines.push(`Discount: ${details.discount}`);
          }
          if (details.description) {
            lines.push(`\nDescription: ${details.description}`);
          }
          if (details.productDetails) {
            lines.push(`\nProduct Details: ${details.productDetails}`);
          }
          if (details.availability && details.availability.length > 0) {
            lines.push(`\nAvailable for delivery: ${details.availability.join(', ')}`);
          }
          lines.push(`\nURL: ${details.url}`);

          return {
            content: [
              {
                type: 'text',
                text: lines.join('\n'),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error getting grocery details: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'add_to_cart',
      description: ADD_TO_CART_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          grocery_url: {
            type: 'string',
            description: 'The Good Eggs URL of the grocery item to add to cart',
          },
          quantity: {
            type: 'number',
            description: 'Quantity to add (default: 1)',
          },
        },
        required: ['grocery_url'],
      },
      handler: async (args: unknown) => {
        try {
          const validated = AddToCartSchema.parse(args);
          const goodEggsClient = await getClient();
          const result = await goodEggsClient.addToCart(validated.grocery_url, validated.quantity);

          return {
            content: [
              {
                type: 'text',
                // An unverified result is not a failure — prefixing it with
                // "Failed to" is exactly the assertion the fix removed.
                text:
                  result.success || result.verified === false
                    ? result.message
                    : `Failed to add to cart: ${result.message}`,
              },
            ],
            // An UNVERIFIED outcome is unknown, not failed, so it is not an error.
            isError: !result.success && result.verified !== false,
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error adding to cart: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'search_for_freebie_groceries',
      description: SEARCH_FREEBIE_GROCERIES_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      handler: async () => {
        try {
          const goodEggsClient = await getClient();
          const results = await goodEggsClient.searchFreebieGroceries();

          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No free items or deals currently available.',
                },
              ],
            };
          }

          const formattedResults = results
            .map(
              (item, i) =>
                `${i + 1}. **${item.name}**\n   Brand: ${item.brand || 'N/A'}\n   Price: ${item.price || 'N/A'}\n   Discount: ${item.discount || 'N/A'}\n   URL: ${item.url}`
            )
            .join('\n\n');

          return {
            content: [
              {
                type: 'text',
                text: `Found ${results.length} deals/freebies:\n\n${formattedResults}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error searching for freebies: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'get_list_of_past_order_dates',
      description: GET_PAST_ORDER_DATES_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      handler: async () => {
        try {
          const goodEggsClient = await getClient();
          const orders = await goodEggsClient.getPastOrderDates();

          if (orders.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No past orders found.',
                },
              ],
            };
          }

          const formattedResults = orders
            .map((order, i) => {
              const parts = [`${i + 1}. **${order.date}**`];
              if (order.total) parts.push(`   Total: ${order.total}`);
              if (order.itemCount) parts.push(`   Items: ${order.itemCount}`);
              return parts.join('\n');
            })
            .join('\n\n');

          return {
            content: [
              {
                type: 'text',
                text: `Found ${orders.length} past orders:\n\n${formattedResults}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error getting past order dates: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'get_past_order_groceries',
      description: GET_PAST_ORDER_GROCERIES_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          past_order_date: {
            type: 'string',
            description: 'The date of the past order to get groceries from (e.g., "2024-01-15")',
          },
        },
        required: ['past_order_date'],
      },
      handler: async (args: unknown) => {
        try {
          const validated = GetPastOrderGroceriesSchema.parse(args);
          const goodEggsClient = await getClient();
          const results = await goodEggsClient.getPastOrderGroceries(validated.past_order_date);

          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No items found for order on ${validated.past_order_date}. Make sure the date matches exactly.`,
                },
              ],
            };
          }

          const formattedResults = results
            .map(
              (item, i) =>
                `${i + 1}. **${item.name}**\n   Brand: ${item.brand || 'N/A'}\n   Quantity Ordered: ${item.quantityOrdered || 1}\n   Unit: ${item.quantity || 'N/A'}\n   Price: ${item.price || 'N/A'}\n   URL: ${item.url}`
            )
            .join('\n\n');

          return {
            content: [
              {
                type: 'text',
                text: `Found ${results.length} items from order on ${validated.past_order_date}:\n\n${formattedResults}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error getting past order groceries: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'add_favorite',
      description: ADD_FAVORITE_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          grocery_url: {
            type: 'string',
            description: 'The Good Eggs URL of the grocery item to add to favorites',
          },
        },
        required: ['grocery_url'],
      },
      handler: async (args: unknown) => {
        try {
          const validated = AddFavoriteSchema.parse(args);
          const goodEggsClient = await getClient();
          const result = await goodEggsClient.addFavorite(validated.grocery_url);

          return {
            content: [
              {
                type: 'text',
                text: result.success
                  ? result.message
                  : `Failed to add to favorites: ${result.message}`,
              },
            ],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error adding to favorites: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'remove_favorite',
      description: REMOVE_FAVORITE_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          grocery_url: {
            type: 'string',
            description: 'The Good Eggs URL of the grocery item to remove from favorites',
          },
        },
        required: ['grocery_url'],
      },
      handler: async (args: unknown) => {
        try {
          const validated = RemoveFavoriteSchema.parse(args);
          const goodEggsClient = await getClient();
          const result = await goodEggsClient.removeFavorite(validated.grocery_url);

          return {
            content: [
              {
                type: 'text',
                text: result.success
                  ? result.message
                  : `Failed to remove from favorites: ${result.message}`,
              },
            ],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error removing from favorites: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'remove_from_cart',
      description: REMOVE_FROM_CART_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          grocery_url: {
            type: 'string',
            description: 'The Good Eggs URL of the grocery item to remove from cart',
          },
        },
        required: ['grocery_url'],
      },
      handler: async (args: unknown) => {
        try {
          const validated = RemoveFromCartSchema.parse(args);
          const goodEggsClient = await getClient();
          const result = await goodEggsClient.removeFromCart(validated.grocery_url);

          return {
            content: [
              {
                type: 'text',
                text:
                  result.success || result.verified === false
                    ? result.message
                    : `Failed to remove from cart: ${result.message}`,
              },
            ],
            // An UNVERIFIED outcome is unknown, not failed, so it is not an error.
            isError: !result.success && result.verified !== false,
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error removing from cart: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    {
      name: 'get_cart',
      description: GET_CART_DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      handler: async () => {
        try {
          const goodEggsClient = await getClient();
          const basket = await goodEggsClient.getBasket();
          const results = basket.items;

          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Your cart is empty. Add items to your cart on Good Eggs to see them here.',
                },
              ],
            };
          }

          const formattedResults = results
            .map(
              (item, i) =>
                // "Line subtotal", not "Price": every other tool's `Price:` is a
                // per-unit price, and a 2 x $5.99 line rendered as `Price: $11.98`
                // is read back as a unit price.
                `${i + 1}. **${item.name}**\n   Brand: ${item.brand || 'N/A'}\n   Quantity: ${item.quantity}\n   Unit: ${item.unit || 'N/A'}\n   Line subtotal: ${item.price || 'N/A'}\n   URL: ${item.url}`
            )
            .join('\n\n');

          // Calculate total items
          const totalItems = results.reduce((sum, item) => sum + item.quantity, 0);
          const subtotal = formatCents(basket.subtotalCents);

          return {
            content: [
              {
                type: 'text',
                text:
                  `Your cart has ${results.length} product${results.length === 1 ? '' : 's'} ` +
                  `(${totalItems} total item${totalItems === 1 ? '' : 's'})` +
                  `${subtotal ? `, subtotal ${subtotal}` : ''}:\n\n${formattedResults}`,
              },
            ],
          };
        } catch (error) {
          // The basket could not be READ. Say that, and say what it does not
          // mean: an error here is "unknown", never "empty". Answering an
          // unreadable basket with "your cart is empty" is what led an agent to
          // tell a user he had removed items he had not touched.
          return {
            content: [
              {
                type: 'text',
                text:
                  `Error getting cart: ${error instanceof Error ? error.message : String(error)}\n\n` +
                  `The cart contents are UNKNOWN, not empty. Do not conclude anything about ` +
                  `what is or is not in the cart from this result.`,
              },
            ],
            isError: true,
          };
        }
      },
    },
  ];

  return (server: Server) => {
    // List available tools. For MCP-App clients, the search tool carries a
    // `_meta` pointer that binds it to the `ui://good-eggs/search-results`
    // resource; for everyone else the listing is byte-identical to before.
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(appUi && tool.name === SEARCH_APP_TOOL
            ? { _meta: searchAppToolMeta() }
            : {}),
        })),
      };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      return await tool.handler(args);
    });

    // --- MCP App: the ui:// resource, gated on the UI extension --------------
    // Registered ONLY when the client advertised `io.modelcontextprotocol/ui`.
    // A plain client never sees these handlers fire and never learns the
    // resource exists — so its surface is unchanged.
    if (appUi) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
          {
            uri: SEARCH_APP_URI,
            name: SEARCH_APP_NAME,
            title: 'Good Eggs — Search results',
            description:
              'Interactive product grid for Good Eggs search results: images, prices, favorites, and add-to-cart.',
            mimeType: SEARCH_APP_MIME,
          },
        ],
      }));

      server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        if (request.params.uri !== SEARCH_APP_URI) {
          throw new Error(`Unknown resource: ${request.params.uri}`);
        }
        return {
          contents: [
            {
              uri: SEARCH_APP_URI,
              mimeType: SEARCH_APP_MIME,
              text: renderSearchAppHtml(),
            },
          ],
        };
      });
    }
  };
}

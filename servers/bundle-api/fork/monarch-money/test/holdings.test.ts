// The strad fork delta for monarch-money: `get_accounts(includeHoldings: true)`
// returned `"holdings": []` for every account, on a workspace where fourteen
// accounts held forty-four positions.
//
// Two things had to be true at once for that to be invisible. The query asked
// for `account(id:) { holdings }`, a field Monarch's schema does not have, so
// every request 400'd; and the handler wrapped each one in `.catch(() => [])`,
// so every 400 became an empty portfolio. Neither half raised anything. A
// caller downstream bucketed asset allocation off those empty arrays and
// understated the money-market slice by roughly twenty times.
//
// So what these tests pin is not "does it parse" but the two properties whose
// absence made a wrong answer look like a right one:
//
//   1. `holdings: []` means the account holds nothing, and NOTHING ELSE. Every
//      way the fetch can fail has to come back as an error.
//   2. The query is shaped against the surface Monarch actually serves.
//
// The fixtures are recorded from the live api.monarch.com endpoint on
// 2026-09-05; provenance for each is at its import below.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { MonarchClient } from '../src/monarch-client/client.js';
import {
  createGraphQLTransport,
  MonarchAuthError,
  MonarchGraphQLError,
  type GraphQLTransport,
} from '../src/monarch-client/graphql-transport.js';
import * as ops from '../src/monarch-client/operations.js';
import { accountTools } from '../src/tools/accounts.js';
import type { Account } from '../src/types.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/**
 * A real 200 from `portfolio(input: {})`, sliced to five aggregate nodes and
 * anonymized: account/holding/security ids replaced with synthetic ones and
 * quantities/values/cost bases regenerated. Every SHAPE is verbatim — which
 * fields are present, which are null, and the nesting — because the shape is
 * the only thing the parser can get wrong.
 *
 * The slice was chosen to cover what the live response actually contains:
 * one security held in four accounts (`VMFXX`), one account holding two
 * different securities (`acct_06`), a null `ticker` on an institution-only
 * fund, a null `costBasis`, a synthetic ticker (`US.DIRECT.INDEXING`), and all
 * four asset classes Monarch returned (`cash`, `equity`, `etf`, `mutual_fund`).
 */
const PORTFOLIO_200 = fixture('portfolio-holdings.json') as {
  data: unknown;
};

/**
 * The real response to the BROKEN query — `account(id:) { holdings { ... } }` —
 * captured verbatim. HTTP 400, with a well-formed GraphQL error body whose
 * `locations` entry points at line 6 column 5: the `holdings` selection.
 *
 * That `locations` entry is the entire diagnosis. Monarch's message is the same
 * generic string for every malformed query, so nothing but the coordinates says
 * which field it rejected.
 */
const ACCOUNT_HOLDINGS_400 = fixture('account-holdings-400.json') as {
  status: number;
  statusText: string;
  body: unknown;
};

function clientOver(transport: GraphQLTransport): MonarchClient {
  return new MonarchClient({ transport, session: { token: 't' } as never });
}

/** A transport that answers every request with one canned payload. */
function transportReturning(data: unknown): GraphQLTransport {
  return { request: async <T,>() => data as T };
}

/** A transport that fails every request. */
function transportThrowing(err: Error): GraphQLTransport {
  return {
    request: async () => {
      throw err;
    },
  };
}

/** A `fetch` that answers once with a given status and body. */
function fetchReturning(status: number, statusText: string, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      statusText,
    })) as unknown as typeof fetch;
}

// =============================================================================
// The query shape — the half that made every request fail
// =============================================================================
//
// A wrong query shape is invisible to a mocked client by construction: the mock
// returns the fixture no matter what was asked for. So the query TEXT is
// asserted directly. These are the assertions a careless re-vendor over this
// fork would fail.

describe('Q_PORTFOLIO_HOLDINGS', () => {
  test('reads the portfolio connection, not a field on Account', () => {
    expect(ops.Q_PORTFOLIO_HOLDINGS).toContain('portfolio(input: $input)');
    expect(ops.Q_PORTFOLIO_HOLDINGS).toContain('aggregateHoldings');
    // The bug, in one assertion. `Account` has no `holdings` field; asking for
    // one 400s the whole query.
    expect(ops.Q_PORTFOLIO_HOLDINGS).not.toMatch(/account\s*\(\s*id:/);
  });

  test('carries the account id on each per-account leg', () => {
    // Without this the response cannot be attributed to accounts at all, and
    // `get_accounts` would have nothing to attach holdings to.
    expect(ops.Q_PORTFOLIO_HOLDINGS).toMatch(/account\s*\{\s*id\s*\}/);
  });

  test('selects the asset class and the joined security', () => {
    // `type`/`typeDisplay` is what separates a money-market fund from equity —
    // the field whose absence produced the 20x misclassification. Matched as
    // whole selection lines: a bare `toContain('type')` is satisfied by
    // `typeDisplay` alone, so it could not fail on its own.
    for (const field of ['type', 'typeDisplay', 'costBasis', 'closingPrice', 'security']) {
      expect(ops.Q_PORTFOLIO_HOLDINGS).toMatch(new RegExp(`^\\s*${field}\\b`, 'm'));
    }
  });

  test('refuses to page silently: it asks whether there is a next page', () => {
    // Monarch rejects a `first:` argument on this connection, so the client has
    // no cursor path — asking is the only way it can tell a whole portfolio
    // from the first slice of one.
    expect(ops.Q_PORTFOLIO_HOLDINGS).toMatch(/pageInfo\s*\{\s*hasNextPage\s*\}/);
  });
});

// =============================================================================
// Parsing the real response shape
// =============================================================================

describe('getHoldingsByAccount', () => {
  test('groups the real portfolio response by account', async () => {
    const byAccount = await clientOver(
      transportReturning(PORTFOLIO_200.data)
    ).getHoldingsByAccount();

    // Nine accounts hold something in the fixture, and `acct_06` holds two
    // different securities that arrive under two different aggregate nodes —
    // so this asserts the regrouping, not just the parse.
    expect([...byAccount.keys()].sort()).toEqual([
      'acct_01',
      'acct_02',
      'acct_03',
      'acct_04',
      'acct_05',
      'acct_06',
      'acct_07',
      'acct_08',
      'acct_09',
    ]);
    expect(byAccount.get('acct_06')?.map((h) => h.ticker).sort()).toEqual(['SGOV', 'SNOW']);
    expect(byAccount.get('acct_01')).toHaveLength(1);
  });

  test('attaches the security and drops the account envelope', async () => {
    const byAccount = await clientOver(
      transportReturning(PORTFOLIO_200.data)
    ).getHoldingsByAccount();

    const vmfxx = byAccount.get('acct_01')?.[0];
    expect(vmfxx?.ticker).toBe('VMFXX');
    // The institution's string for the position and Monarch's canonical name
    // for the security genuinely differ, which is why both are surfaced.
    expect(vmfxx?.name).toBe(
      'Vanguard Money Market Reserves - Federal Money Market Fd USD MNT'
    );
    expect(vmfxx?.security?.name).toBe('Vanguard Federal Money Market Fund');
    expect(vmfxx?.security?.id).toBe('sec_01');
    // The grouping key is the map key; it is not left on the holding.
    expect(vmfxx).not.toHaveProperty('account');
  });

  test('carries the asset class that distinguishes cash from equity', async () => {
    const byAccount = await clientOver(
      transportReturning(PORTFOLIO_200.data)
    ).getHoldingsByAccount();

    // This is the whole point of the fix. A money-market fund is `cash`, and
    // a caller that had to guess from the ticker called it equity.
    expect(byAccount.get('acct_01')?.[0]?.type).toBe('cash');
    expect(byAccount.get('acct_01')?.[0]?.typeDisplay).toBe('Cash');
    expect(byAccount.get('acct_06')?.find((h) => h.ticker === 'SNOW')?.type).toBe('equity');
    expect(byAccount.get('acct_06')?.find((h) => h.ticker === 'SGOV')?.type).toBe('etf');
    expect(byAccount.get('acct_05')?.[0]?.type).toBe('mutual_fund');
  });

  test('preserves the nulls the live API returns', async () => {
    const byAccount = await clientOver(
      transportReturning(PORTFOLIO_200.data)
    ).getHoldingsByAccount();

    // An institution-only fund has no public symbol, on the holding OR on the
    // security. Coercing either to a string would invent a ticker.
    const fund = byAccount.get('acct_05')?.[0];
    expect(fund?.ticker).toBeNull();
    expect(fund?.security?.ticker).toBeNull();
    expect(fund?.security?.currentPrice).toBeNull();
    // Money-market positions commonly report no cost basis.
    expect(byAccount.get('acct_01')?.[0]?.costBasis).toBeNull();
  });

  test('an empty edges array is an empty portfolio, and is not an error', async () => {
    const byAccount = await clientOver(
      transportReturning({ portfolio: { aggregateHoldings: { edges: [] } } })
    ).getHoldingsByAccount();

    expect(byAccount.size).toBe(0);
  });
});

// =============================================================================
// Every fetch failure has to be loud
// =============================================================================
//
// The original `?? []` collapsed a null `portfolio` into an empty portfolio
// with no error at all — a second silent-empty path underneath the `.catch`.

describe('getHoldingsByAccount surfaces failure rather than emptiness', () => {
  test.each([
    ['portfolio is null', { portfolio: null }],
    ['aggregateHoldings is null', { portfolio: { aggregateHoldings: null } }],
    ['edges is null', { portfolio: { aggregateHoldings: { edges: null } } }],
    ['the payload is empty', {}],
  ])('throws when %s', async (_label, payload) => {
    await expect(clientOver(transportReturning(payload)).getHoldingsByAccount()).rejects.toThrow(
      /not an empty portfolio/
    );
  });

  test.each([
    ['a node is null', [{ node: null }]],
    ['a node has no holdings array', [{ node: { holdings: null, security: null } }]],
  ])('throws when %s', async (_label, edges) => {
    // Skipping either would drop a whole security and report the rest as the
    // complete portfolio — the reported bug's output, from the fixed code.
    await expect(
      clientOver(
        transportReturning({ portfolio: { aggregateHoldings: { edges } } })
      ).getHoldingsByAccount()
    ).rejects.toThrow(/no per-account legs/);
  });

  test('throws rather than reporting a truncated page as the whole portfolio', async () => {
    await expect(
      clientOver(
        transportReturning({
          portfolio: {
            aggregateHoldings: {
              pageInfo: { hasNextPage: true },
              edges: [
                {
                  node: {
                    holdings: [{ id: 'h_1', account: { id: 'acct_01' } }],
                    security: null,
                  },
                },
              ],
            },
          },
        })
      ).getHoldingsByAccount()
    ).rejects.toThrow(/cannot page it/);
  });

  test('throws on a holding that cannot be attributed to an account', async () => {
    // Silently dropping it would understate a portfolio by exactly the amount
    // nobody would notice.
    await expect(
      clientOver(
        transportReturning({
          portfolio: {
            aggregateHoldings: {
              edges: [{ node: { holdings: [{ id: 'h_9', account: null }], security: null } }],
            },
          },
        })
      ).getHoldingsByAccount()
    ).rejects.toThrow(/holding \(h_9\) with no account/);
  });

  test('propagates the transport error unchanged', async () => {
    const err = new MonarchGraphQLError('Monarch GraphQL errors: nope', []);
    await expect(clientOver(transportThrowing(err)).getHoldingsByAccount()).rejects.toBe(err);
  });
});

// =============================================================================
// The tool: a failed fetch is an error result, not an empty array
// =============================================================================

const ACCOUNTS: Account[] = [
  { id: 'acct_01', displayName: 'Has holdings' } as Account,
  { id: 'acct_99', displayName: 'Holds nothing' } as Account,
];

function getAccountsTool(overrides: Partial<Record<string, unknown>>) {
  const client = {
    getAccounts: async () => ACCOUNTS,
    ...overrides,
  };
  const tool = accountTools(async () => client as never).find((t) => t.name === 'get_accounts');
  if (!tool) throw new Error('get_accounts is not registered');
  return tool;
}

describe('get_accounts(includeHoldings: true)', () => {
  test('attaches holdings, and an empty array only where there are none', async () => {
    const byAccount = await clientOver(
      transportReturning(PORTFOLIO_200.data)
    ).getHoldingsByAccount();
    const tool = getAccountsTool({ getHoldingsByAccount: async () => byAccount });

    const result = await tool.handler({ includeHoldings: true });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as Array<{
      id: string;
      holdings: Array<{ ticker: string | null }>;
    }>;

    // The regression, stated positively: an account that holds securities
    // comes back holding them.
    expect(parsed[0].holdings).toHaveLength(1);
    expect(parsed[0].holdings[0].ticker).toBe('VMFXX');
    // And an account with no positions still gets an empty array, which now
    // means what it says.
    expect(parsed[1].holdings).toEqual([]);
  });

  test('reports a fetch failure as an error, NOT as empty holdings', async () => {
    const tool = getAccountsTool({
      getHoldingsByAccount: async () => {
        throw new MonarchGraphQLError('Monarch GraphQL errors: Something went wrong (at 6:5)', [
          { message: 'Something went wrong', locations: [{ line: 6, column: 5 }] },
        ]);
      },
    });

    const result = await tool.handler({ includeHoldings: true });

    expect(result.isError).toBe(true);
    // Monarch's own message reaches the caller instead of being discarded.
    expect(result.content[0].text).toContain('Something went wrong (at 6:5)');
    // The failure mode this fork exists to prevent: an error must never be
    // reported as a well-formed list of accounts holding nothing. Asserted as
    // "the payload does not parse as one", rather than as the absence of a
    // substring the error path could never contain anyway.
    expect(() => JSON.parse(result.content[0].text)).toThrow();
  });

  test('reports an auth failure as an auth failure', async () => {
    const tool = getAccountsTool({
      getHoldingsByAccount: async () => {
        throw new MonarchAuthError();
      },
    });

    const result = await tool.handler({ includeHoldings: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not authenticated with Monarch Money');
  });

  test('does not fetch holdings at all when the flag is off', async () => {
    let called = false;
    const tool = getAccountsTool({
      getHoldingsByAccount: async () => {
        called = true;
        return new Map();
      },
    });

    const result = await tool.handler({});
    expect(called).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual(ACCOUNTS);
  });

  test('one request for the whole portfolio, not one per account', async () => {
    // The old shape issued a GraphQL round-trip per account — 56 of them on the
    // workspace where this was reported.
    let requests = 0;
    const transport: GraphQLTransport = {
      request: async <T,>() => {
        requests += 1;
        return PORTFOLIO_200.data as T;
      },
    };
    const client = clientOver(transport);
    const tool = getAccountsTool({
      getHoldingsByAccount: () => client.getHoldingsByAccount(),
    });

    await tool.handler({ includeHoldings: true });
    expect(requests).toBe(1);
  });
});

// =============================================================================
// The transport: a 400 carrying GraphQL errors is a GraphQL error
// =============================================================================
//
// Monarch answers a malformed-for-the-schema query with 400 AND a well-formed
// error body. Branching on `!response.ok` before parsing turned that into a
// generic Error holding 200 truncated characters of JSON — so even with the
// `.catch` gone, the one thing that identified the broken field was unreachable.

describe('graphql transport error classification', () => {
  test('classifies the real 400 from the broken query, locations and all', async () => {
    const transport = createGraphQLTransport({
      credential: { method: 'token', token: 't', source: 'env' },
      fetchImpl: fetchReturning(
        ACCOUNT_HOLDINGS_400.status,
        ACCOUNT_HOLDINGS_400.statusText,
        ACCOUNT_HOLDINGS_400.body
      ),
    });

    const err = await transport.request({ query: '{ x }' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MonarchGraphQLError);
    const gql = err as MonarchGraphQLError;
    // The structured errors survive, so a caller can read the coordinates.
    expect(gql.errors[0].locations).toEqual([{ line: 6, column: 5 }]);
    // And the message names them, because Monarch's own text does not say
    // which field it rejected.
    expect(gql.message).toContain('(at 6:5)');
    expect(gql.message).toContain('Something went wrong while processing');
  });

  test('a 400 with no GraphQL body is still a plain transport error', async () => {
    const transport = createGraphQLTransport({
      credential: { method: 'token', token: 't', source: 'env' },
      fetchImpl: fetchReturning(400, 'Bad Request', '<html>nginx</html>'),
    });

    await expect(transport.request({ query: '{ x }' })).rejects.toThrow(
      /Monarch API request failed: 400 Bad Request/
    );
  });

  test('a 401 is an auth error before anything else', async () => {
    const transport = createGraphQLTransport({
      credential: { method: 'token', token: 't', source: 'env' },
      fetchImpl: fetchReturning(401, 'Unauthorized', { errors: [{ message: 'nope' }] }),
    });

    await expect(transport.request({ query: '{ x }' })).rejects.toBeInstanceOf(MonarchAuthError);
  });

  test('a 200 with a non-JSON body is an error', async () => {
    // The reorder moved this shape from "throw at the parse" to "fall through
    // two later checks", so it is pinned rather than assumed.
    const transport = createGraphQLTransport({
      credential: { method: 'token', token: 't', source: 'env' },
      fetchImpl: fetchReturning(200, 'OK', '<html>a login page</html>'),
    });

    await expect(transport.request({ query: '{ x }' })).rejects.toThrow(/non-JSON response/);
  });

  test('a 5xx carrying GraphQL errors is classified too', async () => {
    const transport = createGraphQLTransport({
      credential: { method: 'token', token: 't', source: 'env' },
      fetchImpl: fetchReturning(502, 'Bad Gateway', { errors: [{ message: 'upstream died' }] }),
    });

    await expect(transport.request({ query: '{ x }' })).rejects.toBeInstanceOf(MonarchGraphQLError);
  });

  test('a 200 with no data and no errors is an error, not an empty result', async () => {
    const transport = createGraphQLTransport({
      credential: { method: 'token', token: 't', source: 'env' },
      fetchImpl: fetchReturning(200, 'OK', {}),
    });

    await expect(transport.request({ query: '{ x }' })).rejects.toThrow(/empty response/);
  });
});

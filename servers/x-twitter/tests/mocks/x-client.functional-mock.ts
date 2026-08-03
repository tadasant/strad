/**
 * Functional-test mock of IXClient. Mocks only the external client boundary
 * (no internal code is mocked). Handlers can be overridden per test.
 */
import { vi } from "vitest";
import type {
  IXClient,
  XBookmarkWriteResponse,
  XListResponse,
  XSingleUserResponse,
  XTweetsLookupResponse,
} from "../../shared/src/types.js";

const ME: XSingleUserResponse = {
  data: {
    id: "1000",
    name: "Mock Me",
    username: "mock_me",
    public_metrics: {
      followers_count: 10,
      following_count: 5,
      tweet_count: 20,
    },
  },
};

const TIMELINE: XListResponse = {
  data: [
    {
      id: "3001",
      text: "timeline tweet",
      author_id: "2000",
      public_metrics: { like_count: 1 },
    },
  ],
  includes: {
    users: [{ id: "2000", name: "Other", username: "other" }],
  },
  meta: { result_count: 1 },
};

export function createMockXClient(overrides: Partial<IXClient> = {}): IXClient {
  return {
    getMe: vi.fn(async () => ME),
    getUserByUsername: vi.fn(async (username: string) =>
      username.replace(/^@/, "") === "mock_me"
        ? ME
        : ({ errors: [{ title: "Not Found Error" }] } as XSingleUserResponse),
    ),
    getHomeTimeline: vi.fn(async () => TIMELINE),
    getUserTweets: vi.fn(async () => TIMELINE),
    getBookmarks: vi.fn(async () => TIMELINE),
    searchRecent: vi.fn(async () => TIMELINE),
    getTweets: vi.fn(
      async (ids: string[]) =>
        ({
          data: ids.map((id) => ({
            id,
            text: `tweet ${id}`,
            author_id: "2000",
          })),
          includes: {
            users: [{ id: "2000", name: "Other", username: "other" }],
          },
        }) as XTweetsLookupResponse,
    ),
    createBookmark: vi.fn(
      async () => ({ data: { bookmarked: true } }) as XBookmarkWriteResponse,
    ),
    removeBookmark: vi.fn(
      async () => ({ data: { bookmarked: false } }) as XBookmarkWriteResponse,
    ),
    ...overrides,
  };
}

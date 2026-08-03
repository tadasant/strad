import { describe, it, expect } from "vitest";
import {
  formatTweetList,
  formatUser,
  tweetText,
} from "../../shared/src/utils/format.js";
import type { XListResponse, XTweet, XUser } from "../../shared/src/types.js";

const AUTHOR: XUser = { id: "2000", name: "Author", username: "author" };

describe("tweetText", () => {
  it("prefers the full note_tweet text over the truncated text", () => {
    const t: XTweet = {
      id: "1",
      text: "Truncated…",
      note_tweet: { text: "The full long-form note tweet body." },
    };
    expect(tweetText(t)).toBe("The full long-form note tweet body.");
  });

  it("falls back to text when there is no note_tweet", () => {
    expect(tweetText({ id: "1", text: "hello" })).toBe("hello");
  });
});

describe("formatTweetList", () => {
  it("renders authors, metrics, and a pagination hint", () => {
    const response: XListResponse = {
      data: [
        {
          id: "3001",
          text: "A tweet",
          author_id: "2000",
          created_at: "2024-06-01T12:00:00.000Z",
          public_metrics: {
            like_count: 10,
            retweet_count: 2,
            reply_count: 1,
            quote_count: 0,
          },
        },
      ],
      includes: { users: [AUTHOR] },
      meta: { result_count: 1, next_token: "NEXT" },
    };

    const text = formatTweetList(response, "empty");
    expect(text).toContain("@author (Author)");
    expect(text).toContain("id: 3001");
    expect(text).toContain("10 likes");
    expect(text).toContain("A tweet");
    expect(text).toContain("pagination_token: NEXT");
  });

  it("returns the empty message when there is no data", () => {
    expect(formatTweetList({ data: [] }, "nothing here")).toBe("nothing here");
  });

  it("includes API errors when present with no data", () => {
    const text = formatTweetList(
      { errors: [{ title: "Forbidden", detail: "client-not-enrolled" }] },
      "empty",
    );
    expect(text).toContain("API errors");
    expect(text).toContain("client-not-enrolled");
  });

  it("labels an unknown author when the author is not in includes", () => {
    const text = formatTweetList(
      { data: [{ id: "1", text: "x", author_id: "missing" }] },
      "empty",
    );
    expect(text).toContain("unknown author");
  });
});

describe("formatUser", () => {
  it("renders username, id, metrics, and bio", () => {
    const user: XUser = {
      id: "1000",
      name: "Me",
      username: "me",
      created_at: "2020-01-01T00:00:00.000Z",
      description: "a bio",
      verified: true,
      public_metrics: {
        followers_count: 123,
        following_count: 45,
        tweet_count: 678,
      },
    };
    const text = formatUser(user);
    expect(text).toContain("@me (Me)");
    expect(text).toContain("[verified]");
    expect(text).toContain("id: 1000");
    expect(text).toContain("followers: 123");
    expect(text).toContain("bio: a bio");
  });
});

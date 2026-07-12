# strad brand voice

How strad sounds in writing: docs, README, console copy, PR descriptions, commit
messages. This is downstream of `BRAND.md` — the voice exists to carry the brand.
When in doubt, plainer and more specific wins.

## Who you're writing to

One smart reader who can read TypeScript and doesn't need their hand held. They
came for a fact, not a mood. Respect their time: lead with the point, be
specific, and stop when you've said it.

## The voice in one line

Plain, direct, and honest — a competent engineer explaining a system they know
cold, with nothing to sell.

## Principles

- **Lead with the point.** No throat-clearing, no "in this section we will." The
  first sentence is the answer.
- **Second person, active voice.** "You add one entry." Not "an entry is added."
- **Be concrete.** Name the file, the constant, the error code. A specific
  `timeoutMs` default of `120_000` beats "a generous timeout," and a withheld
  tool returning `-32600` beats "the request is rejected."
- **Explain the why, skip the obvious.** The reader can see _what_ the code does;
  tell them _why_ it's shaped that way. The interesting fact about the 424 is not
  that it's a 424 — it's that a 401 would have sent the client into an OAuth loop
  against the wrong server.
- **Honest by default.** State what's broken, assumed, or unknown. A visible
  "policy, not physics" is worth more than a confident guess.
- **Confident, not breathless.** No hype. The facts are interesting enough.
- **Let structure carry emphasis.** A heading, a list, or a callout does the work
  that bold-in-the-middle-of-a-sentence tries to do. Reserve **bold** for genuine
  warnings.

## AI-slop tells to cut

These are the patterns that make writing read as machine-generated. Cut them.

- **The antithesis reflex.** "It's not just a gateway, it's a…", "This isn't X,
  it's Y." State the thing directly and delete the foil. If you catch yourself
  writing "not merely," rewrite the sentence. (strad has one sanctioned contrast
  — "the query string proposes, the token disposes" — because it names a real
  mechanism. Don't take it as licence for more.)
- **Em-dash overload.** One dash a paragraph, at most. Prefer a period.
- **Rule-of-three padding.** "Fast, simple, and reliable." Say the one that's
  true and load-bearing; drop the rhythm-fillers.
- **Bold sprinkled for emphasis.** If everything is bold, nothing is. Bold marks
  a warning or a term being defined.
- **Emoji as decoration.** No.
- **Filler verbs and hype adjectives.** Cut: leverage, utilize, delve, dive in,
  unpack, navigate (metaphorical), empower, seamless, robust, powerful,
  effortless, blazing-fast, cutting-edge, elegant.
- **Weasel intensifiers.** Cut: simply, just, basically, essentially, actually,
  really, very, quite.
- **Callout stacking.** Three `:::caution` blocks in a row is a wall, not a
  signal. Consolidate, or fold the minor ones into prose.
- **Generic openers.** "In today's fast-paced world," "Let's take a look."
  Delete on sight.
- **Uniform sentence rhythm.** The short-punchy-fragment-then-a-longer-one
  cadence, repeated, reads as a tic. Vary it, or write plainly.

## Mechanics

- Sentence case for headings. ("Known limitations," not "Known Limitations.")
- Lowercase `strad`, always — including at the start of a sentence. It is not
  capitalised anywhere in the product, and the docs match.
- Oxford comma.
- Backticks for code, paths, identifiers, filenames, env vars, slugs, and error
  codes.
- Numbers that appear in more than one place must agree. strad's docs have been
  wrong about "how many servers" three different ways at once; if you write a
  count, grep for the others.
- Prefer a period to a semicolon in prose.

## Before / after

| Slop                                                                                   | Rewrite                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "strad isn't just a proxy — it's a whole new way to think about MCP infrastructure."   | "strad puts one endpoint in front of many MCP servers."                                                       |
| "Simply leverage our robust, seamless entitlement system for powerful access control." | "A token's roles decide which servers it can reach. `?servers=` can only narrow that set."                    |
| "It's important to note that requests may potentially be rejected in certain cases."   | "A tool withheld by the capability policy is rejected with `-32600` before the request reaches the upstream." |
| "In this section, we'll dive deep into the fascinating world of the deploy spec."      | "The server list decides the container topology. Here's how."                                                 |

## The test

Read it aloud. If it sounds like a person who knows the system talking to a peer,
it passes. If it sounds like a brochure or a chatbot, cut until it doesn't.

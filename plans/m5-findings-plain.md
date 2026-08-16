# What the scan found, in plain terms

**Draft — 16 August 2026.** Source data: `plans/m5-leaderboard.md` §3.1b–3.4.

> **Independently reproduced.** Both breakages were re-run in a clean container
> — different operating system, different version of the underlying runtime, and
> an empty download cache that had never seen this project. Both appeared
> identically. Combined with the check that rebuilding the *original* install
> conditions makes the failure vanish, that rules out both "a quirk of one
> machine" and "it was always broken". Still a draft in wording, not in evidence.

---

## The setup

AI assistants can use tools — "read a file", "search the web", "make a chart". The AI decides which tool to reach for by reading a short written description of each one, a bit like choosing a contractor from their listing. So those descriptions, and the instructions for what information each tool needs, are load-bearing. Get them wrong and the AI picks the wrong tool, or the right tool badly.

We built a scanner that checks these tool collections without running anything and without costing anything, then pointed it at 17 widely-used ones — including the official examples published by the companies that invented the format.

## What came back

### Tools that don't explain what they need

206 cases across 7 collections where a tool demands a piece of information but never says what it should look like. The AI is told "I require a path" with no indication of what counts as one. It guesses.

### Wildly uneven running costs

Every tool's description is re-sent to the AI on *every single message*, whether or not it gets used — like being read the entire menu before each sentence of a conversation. One collection costs 58 times more than another doing broadly comparable work. Two of them are heavy enough to be a real, permanent drag on every request.

### The big one: "pinned to a specific version" doesn't mean what everyone assumes

You can tell your computer "use version 2025.8 of this tool collection, exactly." It obeys — for that collection. But that collection quietly relies on a dozen other pieces of software, and those are *not* frozen. They keep moving underneath it.

So the same version behaves differently depending on the day you install it. We confirmed this by reconstructing the original conditions: installed as it was when published, it works perfectly. Installed today, it doesn't.

Two flavours of broken, and they are not equally bad:

- **Loud** — the software refuses to start. Annoying, but you know immediately. Four of the official examples are in this state right now.
- **Silent** — the dangerous one. The software starts up fine and looks healthy, but the instructions it hands the AI have been hollowed out. Every tool now claims to need *no information at all*. Imagine a recipe book where all the ingredient lists have been wiped but the titles remain, and the cook confidently carries on. Nothing reports an error. The AI just quietly works from a blank page.

To be fair about scope: the *current* releases are fine. This bites setups pinned to older versions — which is a very common and normally sensible thing to do.

## One thing we got wrong, and corrected

The first conclusion was that these projects had shipped broken software. That was wrong, and it was checked before being said publicly.

They shipped working software. It decayed in place, without anyone touching it. That is a meaningfully different — and more unsettling — problem: not carelessness by one team, but a gap in how this software gets distributed, affecting everyone who uses it.

## What we did about it

Two additions to the tool:

- One notices when a collection claims its tools need no information — the silent failure above — and says so loudly.
- The other takes a fingerprint of each collection, so if what arrives tomorrow is not what was measured today, the scanner **refuses to report** rather than quietly measuring something else and calling it the same thing.

That refusal is the important part. The whole point of this project is being honest about when a measurement cannot be trusted, rather than producing a confident number about the wrong thing.

## What this scan is not

The collections examined are all ones that need no password or account key, because a reader who cannot connect cannot check our work. That rules out the tool collections for GitHub, Slack, Linear and similar. So this is **not** a survey of the most popular tool collections, and should not be described as one.

# Play-by-play name resolution is tested against fiction, not ESPN reality

## Summary

`lib/sports/playByPlay.ts` and its three test files
(`playByPlay.test.ts`, `playByPlay.names.test.ts`,
`playByPlay.attribution.test.ts`) have **no recorded contract with the real
ESPN summary endpoint**. Every test input is synthesized by hand (via a
`boxscore({...})` builder or inline `new Map()` rosters) to the shape the
author *assumed* ESPN returns, and the expected outputs are authored by the
same hand. The tests therefore prove only that `expandNames` is internally
consistent with an invented model of ESPN — they cannot fail for the right
reason. 179 "passing" tests validate a fiction.

This surfaced while "optimizing" `playByPlay.attribution.test.ts`. The file
shouldn't exist in its current form: it is a parallel, hand-maintained
fixture set for the same unit (`expandNames`) already covered in
`playByPlay.names.test.ts`, built piecemeal during a debugging session.

## Root cause (first principles)

The module was developed against author-synthesized inputs. Consequences:

1. **A field-name error went undetected.** The code and fixtures read
   `play.participants` (empty) and concluded "ESPN carries no per-play team
   data, so infer team from clause position." The real payload field is
   **`play.teamParticipants`** — and it **is populated**, carrying
   offense/defense team IDs per play. The clause-position heuristic was a
   workaround for a problem created by reading the wrong field.

2. **The parsed text format was never verified against the feed.** The code
   parses `#NN X.Surname` jersey tokens. Some real games use that format;
   others use full names — see evidence below. This was never a deliberate,
   tested decision.

3. **Tests mock input shape AND expected output from the same assumptions**,
   so they are circular. There is no fixture-capture boundary anywhere in the
   repo (`find` for captured payloads returns zero JSON fixtures).

## Evidence (live API, fetched this session)

Two real `college-football/summary` payloads, SAME endpoint, SAME league,
**different play-text formats**:

| event        | play text sample                                             | format        |
|--------------|--------------------------------------------------------------|---------------|
| 401628463    | `Antonio Chadha kickoff for 65 yds, Solomon Vanhorse return` | full names    |
| 401856866    | `#99 B.Laga kickoff 63 yards ... #12 B.Hayes return (#3 R.Damuni; ...)` | `#NN X.Surname` tokens |

Both payloads: `play.participants` is **absent/empty**; `play.teamParticipants`
is **populated**, e.g. for a kickoff:

```json
"teamParticipants": [
  { "id": "84",   "order": 1, "type": "offense" },
  { "id": "2710", "order": 2, "type": "defense" }
]
```

Key observations:
- `teamParticipants[].type` gives authoritative offense/defense team IDs
  per play — this is the per-clause team signal the code currently guesses.
- On KICKOFFS the *receiving* team is tagged `offense` (= `start.team.id`),
  which is the inversion the `attribution.test.ts` name-first resolver was
  built to survive. **The inversion is real** (good), but `teamParticipants`
  provides the correct team binding directly, so most of the name-first /
  clause-position guesswork is unnecessary.
- The full-name format (401628463) flows through `expandNames` as a no-op
  (no tokens) — currently works by accident, never tested deliberately.

(Raw payloads were fetched to `/tmp/cfb.json` and `/tmp/byu.json` during the
session; they are NOT in the repo. Re-fetch via
`https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=<ID>`.)

## Scope of "shouldn't exist"

- `playByPlay.attribution.test.ts` — delete; it duplicates `expandNames`
  coverage already owned by `playByPlay.names.test.ts`, using a second
  hand-built fixture set (`roster`, `stRoster`, `returnRoster`,
  `smithRoster`/`smithCollisionRoster`, `NEB_BALL` = existing `NEB`).
- The synthetic `boxscore({...})` builder inputs in `playByPlay.names.test.ts`
  and `playByPlay.test.ts` — replace with captured real fixtures.

## Required fix (in order — do NOT skip step 1)

1. **Verify current behavior against ground truth FIRST.** Run production
   `extractPlayByPlay` / `expandNames` against BOTH captured payloads and show
   actual output vs. expected. Do not change code before seeing where it is
   wrong against reality. (Two prior fixes this session were made on
   unverified assumptions and one was based on misreading `participants`.)

2. **Establish a fixture-capture boundary.** Commit real bytes to the repo,
   e.g. `lib/sports/__fixtures__/espn/cfb-fullnames-401628463.json` and
   `cfb-tokens-401856866.json`. These become the test inputs. Consider a
   small script to refresh/capture fixtures so the contract is reproducible.

3. **Re-derive team resolution from `teamParticipants`**, not clause-position
   guessing. The offense/defense team IDs per play are authoritative; map
   token team from there. Preserve the kickoff-inversion correctness
   (verify against event 401856866, the `#NN` format game).

4. **Rewrite tests to load captured fixtures** and assert on real
   `extractPlayByPlay` output. Delete `boxscore({...})` synthetic inputs and
   the duplicate `attribution.test.ts`. One source file → one test home for
   `expandNames`.

## Acceptance criteria

- [ ] Both real payload formats (full-name and `#NN` token) are pinned as
      committed fixtures and exercised by tests.
- [ ] `teamParticipants` is the team signal; `participants` is no longer read.
- [ ] Kickoff/return inversion verified correct against event 401856866.
- [ ] No test uses hand-synthesized payload shape AND hand-authored expected
      output for the same behavior (no circular tests).
- [ ] `attribution.test.ts` removed; `expandNames` has a single test home.
- [ ] `tsc --noEmit` clean; full `lib/sports` suite green against real data.

## What NOT to do

- Do not add more synthetic fixtures tuned to make the regex pass.
- Do not silence a mismatch between code and real payload with a fallback —
  fix the field/format handling at the source.
- Do not treat "179 tests pass" as evidence of correctness; they currently
  pass against fiction.

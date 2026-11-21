# #47 — Ambient news reader on the HUD (non-conversational mode)

**Type:** feature
**Branch (proposed):** `feat/ambient-news-reader`
**Depends on:** #45 (card sources — `cardsFromNews` already fetches `description`)
**Hard-blocked by:** #43 (remote input has no ownership gate — see §5)

## Problem

A large fraction of HUD time has no one to talk to. In that time the glasses are
an idle teleprompter. The news cards we already build for the conversation deck
carry real substance in ESPN's `description` field (verified live: the Harden
headline's description is *"posted the 26th 50-point game of his career, passing
the late Kobe Bryant for third-most 50-point games in NBA history."*), but the
deck only ever renders the one-line hook. That substance is worth **reading**
when you're alone — as ambient news, not as a conversation prep hook.

This is a **second consumer of the same card data**, with opposite requirements:

| | Conversation deck (#46) | Ambient reader (this) |
|---|---|---|
| Audience | the person in front of you | just you |
| Voice | hook/question ("Did you see…?") | the fact, plainly |
| Pacing | you step Next/Previous | you step; headline→description on demand |
| Uses | `headline` | `headline` **+ `description`** |
| Stance/audience | yes | **no** — a reader has no audience |

## NOT in scope (explicitly withdrawn)

- **Hot takes / opinions of any kind.** Withdrawn on authenticity grounds, not
  deferred: templated or model-written takes put manufactured opinions in the
  wearer's voice. Do not reintroduce as a "quick win."
- **No new fetching.** `cardsFromNews` already pulls `description`. This issue is
  a *rendering + navigation* layer over the existing `Card[]`. If you find
  yourself adding an ESPN call, stop — wrong issue.
- **No model calls.** Consistent with v1.

## Scope

1. **Surface `description` on the news card model.** `cardsFromNews` currently
   reads `a.description` but drops it. Add `description?: string` to `NewsCard`
   and populate it (trim; omit if empty or equal to the headline — ESPN sets
   `description === headline` for `Media`/highlights rows, which have nothing to
   expand to). No other card kind gets a description.

2. **Reader presentation over the existing `Card[]`.** Reuse `buildDeck`'s output
   (same source as #46) but render with the reader voice: show the plain
   `headline`, not the stance hook. The audience/stance machinery stays out —
   construct the reader's card list from the raw topics with no audience applied,
   or add a `voice: 'reader'` render path that ignores stance. Prefer the former
   (DRY: one card pipeline, two renderers) unless it forces duplication.

3. **Expand-on-demand interaction (the core ask).**
   - A news card shows the **headline** by default.
   - **`single_tap`** (SmartRemote `>>` / touchbar) → advance to next card.
   - **`triple_tap`** (SmartRemote play/pause) → **toggle expand**: if the
     current card has a `description`, show it; a second `triple_tap` collapses
     back to the headline. Cards with no `description` ignore the expand (no-op,
     trace it — do not silently swallow per Zoracon).
   - Use ONLY these event names. `double_tap` is **not emitted by the firmware**
     (EVENT_NAMES has no 0x-code for it; index.tsx line 285 handles a dead event).
     `exit_to_dashboard` (0x00) is firmware screen-reject spam, NOT a gesture —
     ignore it (see packets.ts EVENT_NAMES doc).

4. **Fit the HUD.** A description can exceed one page. Paginate the expanded view
   through the existing text engine (`totalLines`/`curLine`) so a long blurb
   scrolls rather than truncates. Headline view is always one page.

## §5 — Ownership (do not skip — this is why #43 blocks)

The reader must own BOTH the display and the remote while it's foreground, or it
recreates #43 on the input path.

- **Display (already fixed):** claim via `core.claimDisplay('reader')` on focus,
  `releaseDisplay('reader')` on blur. The arbiter in `sendText` now drops
  untagged legacy teleprompter re-pushes (skew-resync, reading-eye) while a
  non-null owner holds the display — tag reader pushes `'reader'`. (Closed for
  the deck in the arbiter fix; same mechanism applies here.)

- **Input (STILL OPEN — this is #43's input side):** `_handleRxEvent` ends in
  `this.eventHandlers.forEach(h => h(event))` — an **unfiltered broadcast**. The
  teleprompter's gesture handler is registered via `addEventHandler` and fires on
  EVERY press with no ownership check. If the reader also registers, a single
  `triple_tap` runs BOTH handlers: the reader expands AND the teleprompter
  toggles pause. **#43 must land first:** make gesture dispatch owner-aware
  (e.g. handlers opt into an owner, and press events route only to the current
  `displayOwner`'s handler), mirroring the display arbiter. Do not ship the
  reader on top of the broadcast-to-all model.

## Acceptance

- [ ] `NewsCard.description` populated; empty/duplicate descriptions omitted.
- [ ] Reader screen renders plain headlines (no stance hook, no audience).
- [ ] `single_tap` advances; `triple_tap` expands/collapses; expand is a no-op
      (traced) on cards with no description.
- [ ] Long descriptions paginate through the text engine, not truncate.
- [ ] Reader claims display + remote on focus, releases on blur.
- [ ] With #43 landed: while reader is foreground, a teleprompter gesture handler
      does NOT fire on the same press (verified on device — the untested case).
- [ ] No new ESPN calls; no model calls; no takes.

## Follow-ons (separate issues, not now)

- Auto-advance / dwell timer for hands-free reading.
- "Save for later" on an expanded card.
- Non-sports sources in the same reader (the reader is source-agnostic).

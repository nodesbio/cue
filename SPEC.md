# Cue — Product Specification
**Version:** 0.2  
**Last updated:** 2025-09-18  
**Hardware target:** Even Realities G1 (640×200 monochrome, 5 text lines, ~45 chars/line)

> v0.2 changes: scroll model changed from page-flip to rolling line-by-line; speed range corrected to real speech rates; loop mode defined; head gestures demoted to opt-in.

---

## 1. What Cue Is

A heads-up display app for G1 glasses with two modes:

1. **Dashboard** — passive, always-on status card. Clock, calendar, tasks, battery.
2. **Teleprompter** — active, scrolling text for speeches, pitches, presentations.

Both modes share the same BLE connection layer. The user switches between them in-app.

---

## 2. Display Constraints (Hardware Truth)

| Property | Value |
|---|---|
| Visible lines | 5 |
| Characters per line | ~45 (proportional font, treat as soft limit) |
| Colours | Monochrome green |
| Scrolling | None built-in — must be sent as successive text packets |
| Max text packet | 191 UTF-8 bytes |
| Emoji support | ✅ basic (→ • 📅 ✓) |
| Bold / colour / size | ❌ |

**Line layout convention (both modes):**
```
Line 1: Status bar   [time]  [indicator]
Line 2: ─────────── content
Line 3: ─────────── content  ← active / reading line
Line 4: ─────────── content
Line 5: ─────────── content
```

---

## 3. Teleprompter Mode

### 3.1 Core Scroll Model — Rolling Window

**Not page-flips. Line-by-line rolling.**

The script is word-wrapped into a flat list of lines. The glasses always show a 5-line window into that list (line 1 = status bar, lines 2–5 = content). On each tick, the window shifts down by 1 line — new content enters at line 5, old content exits at line 2. The eye stays anchored; there is no jarring full-screen refresh.

```
Tick 0:             Tick 1:             Tick 2:
──────────────────  ──────────────────  ──────────────────
7:09 PM  ▶ 2/28    7:09 PM  ▶ 3/28    7:09 PM  ▶ 4/28
Good evening,       everyone. Tonight   we're here to
everyone. Tonight   we're here to       talk about Cue,
we're here to       talk about Cue,     and what we've
talk about Cue,     and what we've      built together.
──────────────────  ──────────────────  ──────────────────
```

**Speed = seconds per line advance** (not per page). This maps directly to speaking pace.

### 3.2 Line Wrapping

- Hard-wrap at 45 chars, breaking at word boundaries
- Blank lines in the source script become empty lines in the window (natural paragraph pauses)
- Very long word (>45 chars): hard-break at 45, no hyphen

### 3.3 Speed Control

Speed range is calibrated to real speech rates (~120–150 WPM). At ~45 chars/line ≈ 7.5 words/line:

| Setting | Seconds/line | Effective WPM | Use case |
|---|---|---|---|
| Slow | 4.5s | ~100 WPM | Formal speeches, dramatic pauses |
| Normal | 3.5s | ~130 WPM | **Default** — conversational pitch |
| Fast | 2.5s | ~180 WPM | High-energy, short-phrase content |
| Manual | ∞ | — | Tap to advance each line |

Speed is adjustable **while running** — no restart required. Slider is continuous, not stepped — the presets are labelled anchors.

### 3.4 Controls (Phone UI)

```
[ ▶ Play / ⏸ Pause ]   [ ← Prev ]   [ Next → ]
[ Slow ●──────────── Fast ] ← speed slider (4.5s–2.5s)
[ line 14 / 56 ]
```

- **Play/Pause:** starts/stops the rolling timer
- **Prev/Next:** jump one line back/forward (resets timer if playing)
- **Speed slider:** live, continuous, takes effect immediately

### 3.5 Status Bar (Line 1)

```
7:09 PM  ▶ 14/56
```

- Time (always)
- ▶ playing / ⏸ paused
- Current line / total lines

### 3.6 End-of-Script Behaviour

**Default: pause and show completion state.**

When the last line of the script scrolls into view, the engine pauses and shows on line 5:

```
── End of script ──
```

The user can then tap Restart on the phone or the line stays frozen until dismissed.

**Loop mode: opt-in, per script.**

A toggle in the script settings: *"Repeat automatically."* When enabled:
- After the last line, insert a 3-second blank buffer, then restart from line 1
- Show a brief `↺ Restarting...` on line 5 during the buffer so the presenter knows it's looping

Loop mode is useful for rehearsal and booth demos. Default is off for live delivery safety.

### 3.7 Default Script

Shown when no script has been loaded — onboarding + demo content:

```
Welcome to Cue.

This is your teleprompter.
Lines roll past one at a time
at your chosen pace.

Load your own script
from the Scripts tab,
or type one here.

Adjust speed with the
slider below. Tap Pause
any time to stop.

Tap Next to advance
one line manually, or let
Cue roll automatically.
```

### 3.8 Script Storage

- Scripts stored locally (AsyncStorage) — no cloud required v1
- Named saves: user can title and save multiple scripts
- Last used script auto-loaded on next open
- Max script length: no hard limit

---

## 4. Head Gesture Navigation

Head gestures are **opt-in only**. Default navigation is the phone UI.

**Why not default:** Natural head movements during speech (nodding, looking at the audience, looking at a prop) will trigger false positives. A missed or accidental line jump during a live pitch is catastrophic for the presenter's flow.

**When enabled (Settings toggle: "Head gesture control"):**
- head_up event → advance 1 line (next)
- head_down event → jump back 1 line (prev)
- 700ms debounce after each trigger — prevents double-fires
- Only active when teleprompter is in Play state (not while paused or in menus)
- Phone controls remain fully functional as fallback

Implementation note: `head_up` / `head_down` events are already parsed in `packets.ts` `EVENT_NAMES` map — just need routing to the engine.

---

## 5. Dashboard Mode

### 5.1 Layout

Line 1 always: `7:09 PM  Thu Sep 18`  
Lines 2–5: active widget

### 5.2 Widgets (Priority Order)

| # | Widget | Data source | Refresh |
|---|---|---|---|
| 1 | Next Task | OmniFocus | 60s |
| 2 | Next Calendar Event | Apple Calendar | 5 min |
| 3 | Clock + Battery | Local | 60s |
| 4 | Weather | Weather API | 30 min |

### 5.3 Rotation

Time-based contextual rotation:

| Time window | Primary widget | Secondary widget |
|---|---|---|
| 6am–12pm | Calendar (what's next) | Tasks |
| 12pm–6pm | Tasks (get things done) | Calendar |
| 6pm–12am | Tomorrow's calendar | Tasks |

Auto-rotates every 30s within the active pair. Status bar always visible.

### 5.4 Widget Format Examples

**Next Task:**
```
7:09 PM  Thu Sep 18
→ NEXT TASK
Follow up: Natalie
Due: today
2 other tasks waiting
```

**Calendar:**
```
7:09 PM  Thu Sep 18
📅 NEXT
Team standup
9:00 AM · in 14 min
3 more today
```

**Clock + Battery (fallback):**
```
7:09 PM  Thu Sep 18
L:100%  R:100%
Connected · H290036
```

---

## 6. App Structure

```
app/
  (tabs)/
    dashboard.tsx         ← Dashboard mode (exists)
    teleprompter.tsx      ← Teleprompter mode (to build)
    scripts.tsx           ← Script library (to build)
    settings.tsx          ← Settings (exists, sparse)
  pairing/                ← Pairing flow (exists, working)

lib/
  g1/
    G1Core.ts             ← BLE core (exists)
    G1Context.tsx         ← React context (exists)
    packets.ts            ← Protocol packets (exists)
  teleprompter/
    lineWrapper.ts        ← Text → string[] of wrapped lines (to build)
    TeleprompterEngine.ts ← Rolling window, timer, play/pause (to build)
  dashboard/
    widgets.ts            ← Widget definitions (to build)
    DashboardEngine.ts    ← Rotation + data fetch (to build)
```

Note: `paginator.ts` renamed to `lineWrapper.ts` — the unit is lines, not pages.

---

## 7. packets.ts Changes Needed

Current `text()` hardcodes `cur_page=1, max_page=1`. Need to expose these for the status bar line counter:

```ts
export function text(str: string, seq: number, curPage = 1, maxPage = 1): Uint8Array {
  const encoded = new TextEncoder().encode(str).slice(0, 191);
  const header = u8(OP_TEXT, seq & 0xff, 1, 0, NEWSCREEN_TEXT_SHOW, 0x00, 0x00, curPage, maxPage);
  return concat(header, encoded);
}
```

`sendText` in G1Core:

```ts
async sendText(str: string, curPage = 1, maxPage = 1): Promise<void>
```

The rolling window sends a full 5-line string on each tick — `curPage` = current line index, `maxPage` = total lines.

---

## 8. Build Order

### Phase 1 — Teleprompter MVP
- [ ] `lineWrapper.ts` — text → `string[]` of hard-wrapped lines
- [ ] `packets.ts` — expose `curPage`/`maxPage` in `text()`
- [ ] `G1Core.ts` — thread through to `sendText`
- [ ] `TeleprompterEngine.ts` — rolling window, timer, play/pause, prev/next, speed, loop mode
- [ ] `teleprompter.tsx` — UI: script input, play/pause, speed slider, line counter
- [ ] Default script content

### Phase 2 — Dashboard Widgets
- [ ] OmniFocus widget
- [ ] Calendar widget
- [ ] Weather widget
- [ ] Rotation logic

### Phase 3 — Script Library
- [ ] `scripts.tsx` — named saves, load/delete, loop toggle per script
- [ ] AsyncStorage persistence

### Phase 4 — Polish
- [ ] Head gesture opt-in (Settings toggle → routes head_up/head_down to engine)
- [ ] BLE stabilisation delay (500ms post-connect before first send)
- [ ] Low-battery handling

---

## 9. Open Questions

1. **Font size** — G1 has a brightness command; does it have a font-size command? Needs protocol research. Would change chars/line estimate.
2. **Blank line handling** — empty lines in source = pause in scroll (hold for N ticks)? Or just show as blank? Natural paragraph breathing suggests hold for 1 extra tick.
3. **MentraOS integration** — if Cue runs inside MentraOS as an app rather than standalone BLE, the transport layer changes. Track this dependency.

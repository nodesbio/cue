# Cue

A teleprompter for [Even Realities G1](https://www.evenrealities.com/) AR glasses. Load a script on your phone, read it hands-free on the lens.

Built with [Expo](https://expo.dev/) + React Native. Connects to the glasses over BLE.

---

## Features

- **Rolling line-by-line scroll** — smooth, no jarring page flips
- **Adjustable speed** — calibrated to real speech rates (100–180 WPM), changeable while running
- **Manual advance** — Prev / Next buttons for full control
- **Head gesture control** — opt-in; head up = play/resume, head down = rewind while held
- **Loop mode** — auto-restart after the last line (great for rehearsal)
- **Local script storage** — no cloud required; save and name multiple scripts
- **Status bar** — always shows time, play state, and line position on the lens

---

## Hardware

**Required:** Even Realities G1 glasses (both lenses must pair).

The G1 exposes a 640×200 monochrome display across 5 text lines (~45 chars/line). Cue sends successive text packets over BLE to produce smooth scrolling.

---

## Getting Started

### Prerequisites

- Node.js 20+
- Expo CLI (`npm install -g expo-cli`)
- iOS device with Bluetooth (BLE required — simulator won't work)
- Even Realities G1 glasses

### Install

```bash
git clone https://github.com/nodes-bio/cue.git
cd cue
npm install
```

### Run

```bash
npx expo run:ios
```

Open the app, tap **Pair**, and follow the on-screen steps. Both lenses (L + R) must connect before the teleprompter activates.

---

## Usage

1. **Pair** your G1 glasses via the pairing flow on first launch
2. **Load a script** — paste text or type directly in the app
3. **Tap Play** — the script rolls line by line on the lens
4. **Adjust speed** with the slider; tap Pause / Prev / Next anytime
5. **Enable head gestures** in Settings if you want hands-free control

---

## Project Structure

```
app/
  (tabs)/
    index.tsx         ← Teleprompter screen
    settings.tsx      ← Settings
  pairing/            ← BLE pairing flow

lib/
  g1/
    G1Core.ts         ← BLE connection + packet I/O
    G1Context.tsx     ← React context / auto-reconnect
    packets.ts        ← Even Realities protocol packets
  teleprompter/
    TeleprompterEngine.ts   ← Rolling window, timer, play/pause/rewind
    lineWrapper.ts          ← Word-wrap to 45-char lines
```

---

## Contributing

PRs welcome. A few things to know:

- The G1 BLE protocol is reverse-engineered. See `lib/g1/packets.ts` for packet formats and `lib/g1/G1Core.ts` for connection logic.
- The teleprompter engine (`TeleprompterEngine.ts`) is framework-free TypeScript with a unit test suite — run with `npm test`.
- Head gesture events (`head_up` / `head_down`) come in over the BLE notification characteristic and are parsed in `packets.ts`.

### Running Tests

```bash
npm test
```

---

## License

MIT © [Nodes Bio, Inc.](https://nodes.bio)

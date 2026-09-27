#!/usr/bin/env bash
# ship.sh — commit, push, build, submit, loop on failure
# Usage: ./scripts/ship.sh [commit message]
#        ./scripts/ship.sh --submit-only <build-id>

set -euo pipefail

PLATFORM=ios
PROFILE=production
MAX_BUILD_ATTEMPTS=3

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[ship]${NC} $*"; }
warn() { echo -e "${YELLOW}[ship]${NC} $*"; }
fail() { echo -e "${RED}[ship]${NC} $*" >&2; }

# ── submit-only shortcut ────────────────────────────────────────────────────
if [[ "${1:-}" == "--submit-only" ]]; then
  BUILD_ID="${2:?Usage: $0 --submit-only <build-id>}"
  log "Submitting build $BUILD_ID..."
  if eas submit --platform "$PLATFORM" --profile "$PROFILE" --id "$BUILD_ID" --non-interactive; then
    log "✅ Submitted. Check TestFlight in ~5 min."
  else
    fail "❌ Submit failed for build $BUILD_ID"
    exit 1
  fi
  exit 0
fi

# ── 1. commit & push ────────────────────────────────────────────────────────
COMMIT_MSG="${1:-chore: ship $(date '+%Y-%m-%d %H:%M')}"

log "Staging all changes..."
git add -A

if git diff --cached --quiet; then
  warn "Nothing to commit — proceeding with push."
else
  log "Committing: $COMMIT_MSG"
  git commit -m "$COMMIT_MSG"
fi

log "Pushing..."
git push

# ── 2. build + submit loop ──────────────────────────────────────────────────
attempt=0
while (( attempt < MAX_BUILD_ATTEMPTS )); do
  (( attempt++ )) || true
  log "Build attempt $attempt / $MAX_BUILD_ATTEMPTS..."

  # Run build in background, tail last line every 5s
  BUILD_OUTPUT=$(mktemp)
  eas build \
      --platform "$PLATFORM" \
      --profile "$PROFILE" \
      --non-interactive \
      > "$BUILD_OUTPUT" 2>&1 &
  EAS_PID=$!
  log "Build running (PID $EAS_PID) — polling every 5s. Full log: $BUILD_OUTPUT"
  while kill -0 "$EAS_PID" 2>/dev/null; do
    LAST=$(tail -1 "$BUILD_OUTPUT" 2>/dev/null | sed 's/^[[:space:]]*//' | cut -c1-100)
    [[ -n "$LAST" ]] && echo -e "  ${YELLOW}…${NC} $LAST"
    sleep 5
  done
  wait "$EAS_PID" && BUILD_STATUS=success || BUILD_STATUS=failed

  # Extract build ID from EAS output (works for both success and failure URLs)
  BUILD_ID=$(grep -oE 'https://expo\.dev/[^ ]+/builds/[a-f0-9-]{36}' "$BUILD_OUTPUT" \
    | grep -oE '[a-f0-9-]{36}$' | head -1 || true)
  # fallback: any UUID-shaped string on a "Build details" line
  if [[ -z "$BUILD_ID" ]]; then
    BUILD_ID=$(grep -i 'build' "$BUILD_OUTPUT" \
      | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' \
      | head -1 || true)
  fi

  if [[ "$BUILD_STATUS" == "failed" ]]; then
    fail "❌ Build attempt $attempt failed."
    if [[ -n "$BUILD_ID" ]]; then
      warn "Build ID: $BUILD_ID"
      warn "Logs: https://expo.dev/accounts/nodesbio/projects/cue/builds/$BUILD_ID"
    fi
    warn "Last 40 lines of output:"
    tail -40 "$BUILD_OUTPUT"

    if (( attempt < MAX_BUILD_ATTEMPTS )); then
      warn "Retrying in 10s... (Ctrl-C to abort)"
      sleep 10
    else
      fail "All $MAX_BUILD_ATTEMPTS attempts failed. Exiting."
      exit 1
    fi
    continue
  fi

  # ── 3. submit ──────────────────────────────────────────────────────────────
  if [[ -z "$BUILD_ID" ]]; then
    warn "Could not parse build ID from output — attempting submit without --id"
    SUBMIT_CMD="eas submit --platform $PLATFORM --profile $PROFILE --non-interactive --latest"
  else
    log "Build succeeded. ID: $BUILD_ID"
    SUBMIT_CMD="eas submit --platform $PLATFORM --profile $PROFILE --id $BUILD_ID --non-interactive"
  fi

  log "Submitting to App Store Connect..."
  if $SUBMIT_CMD; then
    log "✅ Submitted successfully!"
    log "TestFlight processing usually takes 5–15 min."
    log "https://appstoreconnect.apple.com/apps"
    if [[ -n "$BUILD_ID" ]]; then
      log "Build: https://expo.dev/accounts/nodesbio/projects/cue/builds/$BUILD_ID"
    fi
    exit 0
  else
    fail "❌ Submit failed."
    warn "To retry submit: $0 --submit-only $BUILD_ID"
    exit 1
  fi
done

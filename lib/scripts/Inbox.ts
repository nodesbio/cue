/**
 * Inbox.ts — hand-off slot for text arriving from outside the app
 * (iOS/Android share sheet). The share handler in app/_layout.tsx
 * deposits text here; the Teleprompter screen consumes it on focus.
 *
 * A slot rather than an event: on cold start the share arrives before the
 * teleprompter screen (and engine) exist, so there is nobody to emit to yet.
 */

let pending: string | null = null;
const listeners = new Set<() => void>();

export function deposit(text: string): void {
  pending = text;
  for (const fn of listeners) fn();
}

/** Returns and clears the pending text, or null. */
export function take(): string | null {
  const t = pending;
  pending = null;
  return t;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

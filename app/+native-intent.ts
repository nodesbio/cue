import { getShareExtensionKey } from 'expo-share-intent';

/**
 * Expo Router hook for rewriting incoming native deep links before routing.
 *
 * The iOS share extension opens the app via
 * `cue://dataUrl=cueShareKey?nonce=<uuid>#<type>`. That isn't a route — the
 * payload lives in the App Group and is read by useShareIntent() in
 * _layout.tsx — so without this rewrite Expo Router shows "Unmatched Route"
 * (field report 2026-11-04 17:26). Send it to the teleprompter tab; the
 * ShareIntentHandler deposits the text and navigates there anyway.
 *
 * Pattern from expo-share-intent/example/expo-router/app/+native-intent.ts.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) {
      return '/(tabs)';
    }
    return path;
  } catch {
    return '/';
  }
}

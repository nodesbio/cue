import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider, useShareIntent } from 'expo-share-intent';
import * as FileSystem from 'expo-file-system/legacy';
import { G1Provider } from '@/lib/g1/G1Context';
import { deposit } from '@/lib/scripts/Inbox';

/**
 * Share-to-Cue. Any text, URL, or .txt shared from another app lands in the
 * Inbox and the teleprompter picks it up. URLs are kept as-is — the user
 * sees the link on the glasses, which is still useful (and avoids a fetch).
 */
function ShareIntentHandler() {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

  useEffect(() => {
    if (!hasShareIntent) return;
    (async () => {
      let text: string | null = shareIntent.text ?? shareIntent.webUrl ?? null;
      const file = shareIntent.files?.[0];
      if (!text && file?.path) {
        text = await FileSystem.readAsStringAsync(file.path);
      }
      resetShareIntent();
      if (!text?.trim()) return;
      deposit(text);
      // Navigate to Compose, not the index tab: the Inbox drain lives in
      // compose.tsx (drain on mount + subscribe for warm deposits). Routing to
      // /(tabs) [index] could leave shared text sitting in the Inbox unconsumed
      // until the user manually opened Compose. compose.loadScript already
      // pushes the text to the engine, so the teleprompter is primed on return.
      router.navigate('/(tabs)/compose');
    })();
  }, [hasShareIntent]);

  return null;
}

export default function RootLayout() {
  return (
    <ShareIntentProvider>
      <G1Provider>
        <StatusBar style="light" />
        <ShareIntentHandler />
        <Stack screenOptions={{ headerShown: false }} />
      </G1Provider>
    </ShareIntentProvider>
  );
}

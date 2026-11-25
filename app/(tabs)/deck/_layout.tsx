/**
 * app/deck/_layout.tsx — stack for the Decks feature (list → review → editor).
 *
 * The root layout hides headers globally; the deck screens want a native header
 * (back button, title, Save/Edit actions), so this group runs its own Stack with
 * headers shown and a dark theme matching the app.
 */

import { Stack } from 'expo-router';

const BG = '#0a0a0a';
const TEXT = '#ffffff';

export default function DeckLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: BG },
        headerTintColor: TEXT,
        headerTitleStyle: { color: TEXT },
        contentStyle: { backgroundColor: BG },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Decks', headerShown: false }} />
      <Stack.Screen name="[id]" options={{ title: 'Deck' }} />
      <Stack.Screen name="new" options={{ title: 'New Deck', presentation: 'modal' }} />
    </Stack>
  );
}

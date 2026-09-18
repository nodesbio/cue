import { Stack } from 'expo-router';

export default function PairingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="prep" />
      <Stack.Screen name="scan" />
      <Stack.Screen name="connecting" />
      <Stack.Screen name="success" />
    </Stack>
  );
}

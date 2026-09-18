import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { G1Provider } from '@/lib/g1/G1Context';

export default function RootLayout() {
  return (
    <G1Provider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }} />
    </G1Provider>
  );
}

import { Tabs } from 'expo-router';
import { Text } from 'react-native';

const ACTIVE   = '#ffffff';
const INACTIVE = '#555555';
const BG       = '#0a0a0a';
const BORDER   = '#1a1a1a';

function TabIcon({ label, active }: { label: string; active: boolean }) {
  return (
    <Text style={{ fontSize: 18, color: active ? ACTIVE : INACTIVE }}>
      {label}
    </Text>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ACTIVE,
        tabBarInactiveTintColor: INACTIVE,
        tabBarStyle: { backgroundColor: BG, borderTopColor: BORDER },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Teleprompter',
          tabBarIcon: ({ focused }) => <TabIcon label="▶" active={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ focused }) => <TabIcon label="⚙" active={focused} />,
        }}
      />
    </Tabs>
  );
}

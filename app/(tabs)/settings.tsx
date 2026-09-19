import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Switch, Text, View } from 'react-native';

const GESTURE_KEY = 'gesture_nav_enabled';

export default function SettingsScreen() {
  const [gesturesEnabled, setGesturesEnabled] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(GESTURE_KEY).then(v => {
      if (v === 'true') setGesturesEnabled(true);
    }).catch(() => {});
  }, []);

  function toggleGestures(val: boolean) {
    setGesturesEnabled(val);
    AsyncStorage.setItem(GESTURE_KEY, val ? 'true' : 'false').catch(() => {});
  }

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.title}>Settings</Text>

      <Text style={s.section}>Teleprompter</Text>
      <View style={s.row}>
        <View style={s.rowText}>
          <Text style={s.label}>Head gesture control</Text>
          <Text style={s.sub}>Nod up to advance, down to go back. Only active while playing.</Text>
        </View>
        <Switch
          value={gesturesEnabled}
          onValueChange={toggleGestures}
          trackColor={{ false: '#1a1a1a', true: '#00c47a' }}
          thumbColor="#fff"
        />
      </View>

      <Text style={s.section}>About</Text>
      <View style={s.row}><Text style={s.label}>Version</Text><Text style={s.value}>1.0.0</Text></View>
      <View style={s.row}><Text style={s.label}>Bundle</Text><Text style={s.value}>bio.nodes.cue</Text></View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#0a0a0a', paddingHorizontal: 20 },
  title:   { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 20, marginBottom: 24 },
  section: { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginTop: 24, marginBottom: 8 },
  row:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  rowText: { flex: 1, marginRight: 16 },
  label:   { color: '#fff', fontSize: 15 },
  sub:     { color: '#555', fontSize: 12, marginTop: 3 },
  value:   { color: '#888', fontSize: 15 },
});

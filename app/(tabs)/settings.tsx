import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

export default function SettingsScreen() {
  return (
    <SafeAreaView style={s.root}>
      <Text style={s.title}>Settings</Text>
      <View style={s.row}><Text style={s.label}>Version</Text><Text style={s.value}>1.0.0</Text></View>
      <View style={s.row}><Text style={s.label}>Bundle</Text><Text style={s.value}>bio.nodes.cue</Text></View>
      <Text style={s.hint}>More settings coming soon</Text>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:  { flex: 1, backgroundColor: '#0a0a0a', paddingHorizontal: 20 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 20, marginBottom: 24 },
  row:   { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  label: { color: '#888', fontSize: 15 },
  value: { color: '#fff', fontSize: 15 },
  hint:  { color: '#333', fontSize: 12, marginTop: 'auto', textAlign: 'center', paddingBottom: 16 },
});

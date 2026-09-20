import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useIncidentQueue } from './src/ui/useIncidentQueue';
import { SEVERITIES, type Incident, type Severity } from './src/queue/types';

/**
 * Intentionally plain. The brief states this is not a visual-design exercise,
 * so the screen does the minimum needed to make queue state observable:
 * create an incident, see its sync state, retry a failure.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <IncidentScreen />
    </SafeAreaProvider>
  );
}

function IncidentScreen() {
  const { incidents, connectivity, pendingCount, error, ready, create, retry, flush } =
    useIncidentQueue();
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<Severity>('high');

  const submit = async () => {
    // Previously this returned silently, so tapping Add with an empty field
    // looked like a dead button. Surface the reason instead.
    if (!title.trim()) {
      setFormError('Enter a short description first');
      return;
    }
    setFormError(null);
    await create({ title, severity });
    setTitle('');
  };

  if (!ready) {
    return (
      <SafeAreaView style={styles.centred}>
        <ActivityIndicator />
        <Text style={styles.muted}>Opening local queue…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.heading}>Incidents</Text>
        <Text style={[styles.badge, connectivity === 'online' ? styles.online : styles.offline]}>
          {connectivity}
        </Text>
      </View>
      <Text style={styles.muted}>
        {pendingCount} awaiting sync · tap Sync now to force an attempt
      </Text>

      {formError ?? error ? (
        <Text style={styles.banner}>{formError ?? error}</Text>
      ) : null}

      <TextInput
        style={styles.input}
        placeholder="What happened?"
        value={title}
        onChangeText={(t) => {
          setTitle(t);
          if (formError) setFormError(null);
        }}
        onSubmitEditing={submit}
        returnKeyType="done"
      />

      <View style={styles.row}>
        {SEVERITIES.map((s) => (
          <Pressable
            key={s}
            onPress={() => setSeverity(s)}
            style={[styles.chip, severity === s && styles.chipOn]}
          >
            <Text style={severity === s ? styles.chipOnText : styles.chipText}>{s}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.row}>
        <Pressable
          style={[styles.button, !title.trim() && styles.buttonDisabled]}
          onPress={submit}
        >
          <Text style={styles.buttonText}>Add incident</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.secondary]} onPress={flush}>
          <Text style={styles.buttonText}>Sync now</Text>
        </Pressable>
      </View>

      <FlatList
        data={incidents}
        keyExtractor={(i) => i.id}
        ListEmptyComponent={<Text style={styles.muted}>No incidents yet.</Text>}
        renderItem={({ item }) => <Row incident={item} onRetry={() => retry(item.id)} />}
      />
    </SafeAreaView>
  );
}

function Row({ incident, onRetry }: { incident: Incident; onRetry: () => void }) {
  const showRetry = incident.syncState === 'failed';
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{incident.title}</Text>
      <Text style={styles.muted}>
        {incident.severity} · {new Date(incident.createdAt).toLocaleTimeString()} ·{' '}
        <Text style={stateStyle(incident)}>{incident.syncState}</Text>
        {incident.attempts > 0 ? ` · ${incident.attempts} attempt(s)` : ''}
      </Text>
      {incident.lastError ? <Text style={styles.error}>{incident.lastError}</Text> : null}
      <Text style={styles.id}>{incident.id}</Text>
      {showRetry ? (
        <Pressable style={[styles.button, styles.retry]} onPress={onRetry}>
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function stateStyle(incident: Incident) {
  switch (incident.syncState) {
    case 'synced':
      return styles.synced;
    case 'failed':
      return styles.failed;
    case 'syncing':
      return styles.syncing;
    default:
      return styles.pending;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16, paddingTop: 8, backgroundColor: '#fff', gap: 8 },
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: 24, fontWeight: '700' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, overflow: 'hidden', color: '#fff', fontWeight: '600' },
  online: { backgroundColor: '#137333' },
  offline: { backgroundColor: '#8a1c1c' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#ccc' },
  chipOn: { backgroundColor: '#1a237e', borderColor: '#1a237e' },
  chipText: { color: '#333' },
  chipOnText: { color: '#fff', fontWeight: '600' },
  button: { backgroundColor: '#1a237e', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  secondary: { backgroundColor: '#455a64' },
  buttonDisabled: { opacity: 0.5 },
  retry: { alignSelf: 'flex-start', marginTop: 8, backgroundColor: '#8a1c1c' },
  buttonText: { color: '#fff', fontWeight: '600' },
  card: { borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 10, padding: 12, marginTop: 10, gap: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  muted: { color: '#666', fontSize: 13 },
  id: { color: '#999', fontSize: 11, fontFamily: 'monospace' },
  error: { color: '#8a1c1c', fontSize: 13 },
  banner: {
    backgroundColor: '#fdecea',
    color: '#8a1c1c',
    padding: 8,
    borderRadius: 6,
    fontSize: 13,
  },
  pending: { color: '#8a6d00', fontWeight: '600' },
  syncing: { color: '#1a237e', fontWeight: '600' },
  synced: { color: '#137333', fontWeight: '600' },
  failed: { color: '#8a1c1c', fontWeight: '600' },
});

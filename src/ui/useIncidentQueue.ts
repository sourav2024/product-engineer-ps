import { useCallback, useEffect, useMemo, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import * as SQLite from 'expo-sqlite';
import { SyncEngine } from '../queue/syncEngine';
import { SqliteIncidentStorage } from '../queue/sqliteStorage';
import { HttpIncidentTransport } from '../queue/transport';
import type { Incident, NewIncidentInput } from '../queue/types';
import { SERVER_URL } from '../config';

export type Connectivity = 'online' | 'offline' | 'unknown';

/**
 * Binds the queue engine to React.
 *
 * The hook owns no synchronization logic of its own: it subscribes to engine
 * snapshots, forwards user intent, and triggers a flush when connectivity
 * returns. All decisions about when and what to deliver stay in the engine.
 */
export function useIncidentQueue() {
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [connectivity, setConnectivity] = useState<Connectivity>('unknown');

  const transport = useMemo(() => new HttpIncidentTransport(SERVER_URL), []);

  // Open the database once, recover anything interrupted by a previous crash,
  // then publish the first snapshot.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const db = await SQLite.openDatabaseAsync('incidents.db');
      const storage = await SqliteIncidentStorage.open(db);
      const created = new SyncEngine({ storage, transport });

      await created.recoverInterrupted();
      if (cancelled) return;

      setIncidents(await created.list());
      setEngine(created);
    })();

    return () => {
      cancelled = true;
    };
  }, [transport]);

  useEffect(() => {
    if (!engine) return;
    return engine.subscribe(setIncidents);
  }, [engine]);

  // Connectivity is an input to *when* we flush, never a source of truth about
  // what has been delivered — only a server acknowledgement decides that.
  useEffect(() => {
    return NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      setConnectivity(online ? 'online' : 'offline');
      if (online) void engine?.flush();
    });
  }, [engine]);

  const create = useCallback(
    async (input: NewIncidentInput) => {
      if (!engine) return;
      await engine.create(input);
      void engine.flush(); // no-op offline; the attempt simply fails and retries
    },
    [engine],
  );

  const retry = useCallback((id: string) => engine?.retry(id), [engine]);
  const flush = useCallback(() => engine?.flush(), [engine]);

  const pendingCount = incidents.filter((i) => i.syncState !== 'synced').length;

  return { incidents, connectivity, pendingCount, ready: engine !== null, create, retry, flush };
}

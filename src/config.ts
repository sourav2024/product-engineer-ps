/**
 * Base URL of the incident receiver.
 *
 * A physical device cannot reach the host's `localhost`, so this is overridable
 * without editing source: set EXPO_PUBLIC_SERVER_URL to the host's LAN address
 * (for example http://192.168.1.20:4000) before starting Expo.
 */
export const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? 'http://localhost:4000';

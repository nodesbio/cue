// app.config.ts runs under Node at build time; its tsconfig doesn't expose
// @types/node, so we require() child_process untyped rather than pull node types
// into the app's type graph. execSync is the only symbol used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const execSync = require('child_process').execSync as (cmd: string, opts?: unknown) => { toString(): string };
import type { ExpoConfig } from 'expo/config';

// Resolve the git SHA at config-eval time so EVERY build path bakes a real
// commit into the on-glass [BUILD] stamp — local `expo run:ios` AND the EAS
// cloud build (EAS checks out the repo, so git is available there too). The
// previous scheme relied on a shell export that no script actually set and
// wouldn't survive the cloud build anyway, so every field log stamped
// "nocommit" and couldn't be tied to a build (the 2026-11-15/17 log confusion).
// EAS exposes EAS_BUILD_GIT_COMMIT_HASH; fall back to git, then 'nocommit'.
function resolveGitSha(): string {
  if (process.env.EAS_BUILD_GIT_COMMIT_HASH) {
    return process.env.EAS_BUILD_GIT_COMMIT_HASH.slice(0, 7);
  }
  try {
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().length > 0;
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'nocommit';
  }
}

process.env.EXPO_PUBLIC_GIT_SHA = resolveGitSha();

const config: ExpoConfig = {
  name: 'Cue',
  slug: 'cue-glasses',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'cue',
  userInterfaceStyle: 'dark',
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    url: 'https://u.expo.dev/11a5a62e-83b3-4b48-9704-437201cde5fb',
    checkAutomatically: 'ON_ERROR_RECOVERY',
    fallbackToCacheTimeout: 0,
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'bio.nodes.cue',
    buildNumber: '1',
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSBluetoothAlwaysUsageDescription:
        'Cue connects to your Even Realities G1 glasses to display text on the HUD.',
      NSBluetoothPeripheralUsageDescription:
        'Cue connects to your Even Realities G1 glasses to display text on the HUD.',
      // audio: keeps the SmartRemoteManager silent-loop AVAudioSession alive
      //   when the phone is locked/backgrounded. Without it iOS suspends the
      //   session on lock, reclaims MPRemoteCommandCenter media keys (SmartRemote
      //   stops controlling the teleprompter) AND suspends the JS runtime (scroll
      //   timer freezes). Required for lock-screen operation. See SmartRemoteManager.ts.
      // bluetooth-central/peripheral: BLE writes to the G1 glasses survive lock.
      UIBackgroundModes: ['bluetooth-central', 'bluetooth-peripheral', 'audio'],
    },
  },
  android: {
    package: 'bio.nodes.cue',
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundColor: '#0a0a0a',
    },
    permissions: [
      'android.permission.BLUETOOTH',
      'android.permission.BLUETOOTH_ADMIN',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.ACCESS_FINE_LOCATION',
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-share-intent',
      {
        iosActivationRules: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsFileWithMaxCount: 1,
        },
        androidIntentFilters: ['text/*'],
      },
    ],
    [
      'react-native-ble-plx',
      {
        isBackgroundEnabled: true,
        modes: ['peripheral', 'central'],
        bluetoothAlwaysPermission:
          'Allow Cue to connect to your G1 glasses.',
      },
    ],
  ],
  experiments: { typedRoutes: true },
  extra: {
    eas: { projectId: '11a5a62e-83b3-4b48-9704-437201cde5fb' },
  },
  owner: 'nodes-bio',
};

export default config;

import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Cue',
  slug: 'cue-glasses',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'cue',
  userInterfaceStyle: 'dark',
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    url: 'https://u.expo.dev/TBD',
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
      UIBackgroundModes: ['bluetooth-central'],
    },
  },
  android: {
    package: 'bio.nodes.cue',
    adaptiveIcon: {
      foregroundImage: './assets/images/adaptive-icon.png',
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
    eas: { projectId: 'TBD' },
  },
  owner: 'nodes-bio',
};

export default config;

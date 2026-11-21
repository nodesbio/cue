/**
 * Minimal manual Jest mock for react-native.
 *
 * ts-jest only transforms .ts/.tsx, so the real react-native ESM entry can't be
 * imported in node-env tests. G1Core touches only Platform + AppState at import
 * time; stub exactly those. This file is in __mocks__/ adjacent to node_modules,
 * so it is applied automatically to any test that imports 'react-native' and is
 * inert for the pure tests that never do.
 */
const Platform = { OS: 'ios', select: (obj) => obj.ios ?? obj.default };

const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
  removeEventListener: () => {},
};

module.exports = { Platform, AppState };

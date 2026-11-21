/**
 * Manual Jest mock for react-native-ble-plx.
 *
 * The real package ships ESM that ts-jest (which only transforms .ts/.tsx) hands
 * to Node untransformed, so importing G1Core for pure-logic tests (e.g. the
 * display-owner arbiter) blows up on `export`. G1Core only needs these symbols
 * to exist at import time — it opens no BLE in the constructor — so stub them.
 */
class BleManager {}
class Device {}
class Characteristic {}
class Subscription {}
class BleError extends Error {}

const State = {
  Unknown: 'Unknown',
  Resetting: 'Resetting',
  Unsupported: 'Unsupported',
  Unauthorized: 'Unauthorized',
  PoweredOff: 'PoweredOff',
  PoweredOn: 'PoweredOn',
};

const BleErrorCode = {};

module.exports = {
  BleManager,
  Device,
  Characteristic,
  Subscription,
  BleError,
  State,
  BleErrorCode,
};

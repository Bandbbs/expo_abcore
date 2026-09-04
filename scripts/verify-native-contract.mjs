import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const androidModule = read('android/src/main/java/com/bandbbs/expoabcore/ExpoABCoreModule.kt');
const androidStore = read('android/src/main/java/com/bandbbs/expoabcore/SecureJsonStore.kt');
const androidManifest = read('android/src/main/AndroidManifest.xml');
const iosModule = read('ios/ExpoABCoreModule.swift');
const iosStore = read('ios/KeychainJsonStore.swift');
const plugin = read('plugin/withExpoABCore.js');
const types = read('src/types.ts');

const events = [
  'scanResult',
  'scanStateChanged',
  'connectionChanged',
  'deviceSnapshotChanged',
  'installJobChanged',
];
for (const event of events) {
  assert.match(androidModule, new RegExp(`"${event}"`));
  assert.match(iosModule, new RegExp(`"${event}"`));
  assert.match(types, new RegExp(`\\b${event}:`));
}

for (const permission of [
  'BLUETOOTH',
  'BLUETOOTH_ADMIN',
  'BLUETOOTH_SCAN',
  'BLUETOOTH_CONNECT',
  'ACCESS_COARSE_LOCATION',
  'ACCESS_FINE_LOCATION',
]) {
  assert.match(androidManifest, new RegExp(`android.permission.${permission}`));
  assert.match(plugin, new RegExp(`android.permission.${permission}`));
}
assert.match(plugin, /android:maxSdkVersion/);
assert.doesNotMatch(plugin, /neverForLocation/);
assert.match(androidStore, /\.commit\(\)/);
assert.doesNotMatch(androidStore, /\.apply\(\)/);
assert.match(plugin, /NSBluetoothAlwaysUsageDescription/);
assert.doesNotMatch(plugin, /UIBackgroundModes/);

assert.match(androidStore, /AndroidKeyStore/);
assert.match(androidStore, /AES\/GCM\/NoPadding/);
assert.match(iosStore, /kSecClassGenericPassword/);
assert.match(iosStore, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
const publicProfileType = /export type DeviceProfile = \{([\s\S]*?)\n\};/.exec(types)?.[1] ?? '';
for (const secret of ['authKey', 'openId', 'phoneDeviceId']) {
  assert.match(iosModule, new RegExp(`removeValue\\(forKey: "${secret}"\\)`));
  assert.doesNotMatch(publicProfileType, new RegExp(`\\b${secret}\\??:`));
}
assert.match(read('android/src/main/java/com/bandbbs/expoabcore/RustBridge.kt'), /CodedException/);
assert.match(iosModule, /ExpoModulesCore\.Exception/);

console.log('Verified native events, permissions, secure storage, and coded errors.');

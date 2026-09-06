import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const androidModule = read('android/src/main/java/com/bandbbs/expoabcore/ExpoABCoreModule.kt');
const androidTransport = read('android/src/main/java/com/bandbbs/expoabcore/BluetoothTransport.kt');
const androidStore = read('android/src/main/java/com/bandbbs/expoabcore/SecureJsonStore.kt');
const androidManifest = read('android/src/main/AndroidManifest.xml');
const iosModule = read('ios/ExpoABCoreModule.swift');
const iosTransport = read('ios/BluetoothTransport.swift');
const iosStore = read('ios/KeychainJsonStore.swift');
const plugin = read('plugin/withExpoABCore.js');
const rustBuild = read('scripts/build-rust.mjs');
const types = read('src/types.ts');
const iosRustArchive = readFileSync(
  resolve(root, 'ios/Native/ExpoABCoreRust.xcframework/ios-arm64/libexpo_abcore.a'),
);

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
assert.match(plugin, /neverForLocation/);
assert.match(androidManifest, /android:name="android\.permission\.ACCESS_COARSE_LOCATION" android:maxSdkVersion="30"/);
assert.match(androidManifest, /android:name="android\.permission\.ACCESS_FINE_LOCATION" android:maxSdkVersion="30"/);
assert.match(androidManifest, /android:name="android\.permission\.BLUETOOTH_SCAN"[\s\S]*android:usesPermissionFlags="neverForLocation"/);
assert.match(
  androidModule,
  /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S -> arrayOf\([\s\S]*Manifest\.permission\.BLUETOOTH_SCAN,[\s\S]*Manifest\.permission\.BLUETOOTH_CONNECT,[\s\S]*\)/,
);
const androidRuntimePermissionStart = androidModule.indexOf(
  'Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> arrayOf(',
);
const androidRuntimePermissionEnd = androidModule.indexOf(
  'Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> arrayOf(',
  androidRuntimePermissionStart,
);
const androidRuntimeSBlock = androidModule.slice(
  androidRuntimePermissionStart,
  androidRuntimePermissionEnd,
);
assert.doesNotMatch(
  androidRuntimeSBlock,
  /Manifest\.permission\.ACCESS_FINE_LOCATION/,
);
assert.match(androidTransport, /onScanFailed\(errorCode: Int\)/);
assert.match(androidTransport, /scanFailureListener\?\.invoke\("ble"/);
assert.match(androidTransport, /ScanStartResult\(/);
assert.match(androidTransport, /"BLE_SCAN_FAILED"/);
assert.match(androidTransport, /@Volatile private var bleScanCallback/);
assert.match(androidTransport, /if \(bleScanCallback !== this\) return/);
assert.match(androidTransport, /synchronized\(scannedDevicesLock\)/);
assert.match(androidModule, /payload\["errorCode"\] = errorCode/);
assert.match(androidModule, /catch \(error: CancellationException\)/);
assert.match(androidModule, /"SCAN_POLL_FAILED"/);
assert.match(androidModule, /val wantsSpp = transportFilter == "spp"/);
assert.doesNotMatch(androidModule, /val wantsSpp = transportFilter == null \|\| transportFilter == "spp"/);
assert.match(androidStore, /\.commit\(\)/);
assert.doesNotMatch(androidStore, /\.apply\(\)/);
assert.match(plugin, /NSBluetoothAlwaysUsageDescription/);
assert.match(plugin, /UIBackgroundModes/);
assert.match(plugin, /bluetooth-central/);
assert.match(iosTransport, /CBCentralManagerOptionRestoreIdentifierKey/);
assert.match(iosTransport, /willRestoreState/);
assert.match(iosTransport, /didUpdateNotificationStateFor/);
assert.match(iosTransport, /characteristic\.isNotifying/);
assert.match(iosTransport, /notificationAuthorizationTimeout: TimeInterval = 120/);
assert.match(iosTransport, /activePeripheral\?\.identifier == peripheral\.identifier/);
assert.match(iosTransport, /sendLock\.lock\(\)/);
assert.match(iosTransport, /serviceProbeCharacteristic/);
assert.match(iosTransport, /peripheral\.readValue\(for: probe\)/);
assert.match(iosModule, /OnAppBecomesActive/);
assert.match(iosModule, /preferred_device_profile_v1/);
assert.match(iosModule, /protocolTrace/);
assert.match(rustBuild, /syncDirectoryInPlace/);
assert.match(rustBuild, /\.ExpoABCoreRust-\$\{process\.pid\}\.xcframework/);
assert.doesNotMatch(rustBuild, /rmSync\(output,/);
assert.equal(iosRustArchive.includes(Buffer.from('Missing resource target')), true);

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

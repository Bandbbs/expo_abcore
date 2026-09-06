import assert from 'node:assert/strict';

import withExpoABCore from '../plugin/withExpoABCore.js';

const permission = (name, attributes = {}) => ({
  $: { 'android:name': name, ...attributes },
});

const managedNames = [
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  'android.permission.POST_NOTIFICATIONS',
];

const applyAndroidManifestPlugin = async (manifest) => {
  const config = withExpoABCore({ expo: {}, mods: {} });
  const result = await config.mods.android.manifest({
    modResults: { manifest },
    modRequest: { platformName: 'android', projectRoot: process.cwd() },
  });
  return result.modResults.manifest;
};

const initialManifest = {
  'uses-permission': [
    permission('android.permission.BLUETOOTH', {
      'android:maxSdkVersion': '29',
      'android:usesPermissionFlags': 'stale',
    }),
    permission('android.permission.BLUETOOTH_ADMIN'),
    permission('android.permission.BLUETOOTH_SCAN', {
      'android:maxSdkVersion': '30',
      'android:usesPermissionFlags': 'stale',
    }),
    permission('android.permission.BLUETOOTH_SCAN'),
    permission('android.permission.BLUETOOTH_CONNECT', {
      'android:maxSdkVersion': '30',
      'android:usesPermissionFlags': 'stale',
    }),
    permission('android.permission.ACCESS_COARSE_LOCATION', {
      'android:maxSdkVersion': '29',
      'android:usesPermissionFlags': 'stale',
    }),
    permission('android.permission.ACCESS_FINE_LOCATION'),
    permission('android.permission.FOREGROUND_SERVICE'),
    permission('android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE'),
    permission('android.permission.POST_NOTIFICATIONS'),
    permission('android.permission.INTERNET'),
  ],
};

const first = await applyAndroidManifestPlugin(structuredClone(initialManifest));
const second = await applyAndroidManifestPlugin(structuredClone(first));
assert.deepEqual(second, first, 'config plugin should be idempotent');

const permissions = second['uses-permission'];
const managed = permissions.filter((entry) =>
  managedNames.includes(entry.$?.['android:name']),
);
assert.equal(managed.length, managedNames.length);

const byName = (name) => permissions.find((entry) => entry.$?.['android:name'] === name)?.$;
for (const name of [
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
]) {
  assert.deepEqual(byName(name), {
    'android:name': name,
    'android:maxSdkVersion': '30',
  });
}
assert.deepEqual(byName('android.permission.BLUETOOTH_SCAN'), {
  'android:name': 'android.permission.BLUETOOTH_SCAN',
  'android:usesPermissionFlags': 'neverForLocation',
});
assert.deepEqual(byName('android.permission.BLUETOOTH_CONNECT'), {
  'android:name': 'android.permission.BLUETOOTH_CONNECT',
});

console.log('Verified idempotent Android permission normalization.');

const {
  AndroidConfig,
  withAndroidManifest,
  withInfoPlist,
} = require('expo/config-plugins');

const ANDROID_PERMISSIONS = [
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
];

function withExpoABCore(config, options = {}) {
  config = withInfoPlist(config, (next) => {
    next.modResults.NSBluetoothAlwaysUsageDescription =
      options.bluetoothPermission ||
      '允许应用通过蓝牙连接、管理设备并安装资源。';
    return next;
  });

  return withAndroidManifest(config, (next) => {
    for (const permission of ANDROID_PERMISSIONS) {
      AndroidConfig.Permissions.addPermission(next.modResults, permission);
    }

    const permissions = next.modResults.manifest['uses-permission'] || [];
    for (const entry of permissions) {
      const name = entry.$?.['android:name'];
      if (
        name === 'android.permission.BLUETOOTH' ||
        name === 'android.permission.BLUETOOTH_ADMIN' ||
        name === 'android.permission.ACCESS_COARSE_LOCATION' ||
        name === 'android.permission.ACCESS_FINE_LOCATION'
      ) {
        entry.$['android:maxSdkVersion'] = '30';
      }
      if (name === 'android.permission.BLUETOOTH_SCAN') {
        entry.$['android:usesPermissionFlags'] = 'neverForLocation';
      }
    }
    next.modResults.manifest['uses-feature'] ||= [];
    if (
      !next.modResults.manifest['uses-feature'].some(
        (feature) => feature.$?.['android:name'] === 'android.hardware.bluetooth_le',
      )
    ) {
      next.modResults.manifest['uses-feature'].push({
        $: {
          'android:name': 'android.hardware.bluetooth_le',
          'android:required': 'false',
        },
      });
    }
    return next;
  });
}

module.exports = withExpoABCore;

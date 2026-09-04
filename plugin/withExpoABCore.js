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

    const managedPermissions = new Set(ANDROID_PERMISSIONS);
    const seenPermissions = new Set();
    const permissions = (next.modResults.manifest['uses-permission'] || []).filter((entry) => {
      const name = entry.$?.['android:name'];
      if (!managedPermissions.has(name)) return true;
      if (seenPermissions.has(name)) return false;
      seenPermissions.add(name);
      return true;
    });
    next.modResults.manifest['uses-permission'] = permissions;
    for (const entry of permissions) {
      const name = entry.$?.['android:name'];
      if (
        name === 'android.permission.BLUETOOTH' ||
        name === 'android.permission.BLUETOOTH_ADMIN'
      ) {
        entry.$['android:maxSdkVersion'] = '30';
      }
      if (
        name === 'android.permission.ACCESS_COARSE_LOCATION' ||
        name === 'android.permission.ACCESS_FINE_LOCATION'
      ) {
        delete entry.$['android:maxSdkVersion'];
      }
      if (name === 'android.permission.BLUETOOTH_SCAN') {
        delete entry.$['android:usesPermissionFlags'];
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

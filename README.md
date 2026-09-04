# expo-abcore

`expo-abcore` is an Expo SDK 57 native module that brings the AstroBox Xiaomi
and vivo wearable protocols to Android and iOS applications. It supports saved
device profiles, Android BLE/SPP, iOS BLE, device information, and serial
watchface, quick-app, and firmware installation.

The package is distributed as a GitHub Release tarball. Rust is only required
to build a release; consuming Expo projects use the bundled native artifacts.

## Install

Pin the release tarball in the consuming Expo 57 project and enable the config
plugin:

```json
{
  "dependencies": {
    "expo-abcore": "https://github.com/Bandbbs/expo_abcore/releases/download/v0.1.0/expo-abcore-0.1.0.tgz"
  },
  "expo": {
    "plugins": ["expo-abcore"]
  }
}
```

The plugin declares foreground Bluetooth and precise location permissions for
Android, matching AstroBox's BLE discovery requirements, and the iOS Bluetooth
usage description. It does not enable background Bluetooth modes.
Run Expo prebuild after installing the dependency. Android release artifacts
include `arm64-v8a`, `armeabi-v7a`, and `x86_64`; the iOS XCFramework includes
arm64 device and arm64/x86_64 simulator slices.

The public TypeScript entry point exposes device scanning, secure saved device
profiles, one active connection, device snapshots, file classification, and a
persistent serial installation queue. Credentials are stored by the native
module in Android Keystore-backed encrypted storage or iOS Keychain. JavaScript
only receives `hasCredentials` for saved profiles.

See `UPSTREAM-VERSIONS.md` for the pinned AstroBox revisions. Each release also
ships a complete source archive and `SHA256SUMS` beside the runtime tarball.

## License

The module is licensed under GNU AGPL 3.0 only, with the AstroBox attribution
terms in `ADDITIONAL-TERMS.md`. `LINKING-EXCEPTION.md` contains a narrow
additional permission for hosts listed in `AUTHORIZED_HOSTS.md`.

The GitHub `release` environment must define `LINKING_EXCEPTION_APPROVED=true`
after the relevant copyright holders have approved the linking exception. The
release workflow stops before checkout when that approval record is absent.

AstroBox-NG: https://github.com/AstralSightStudios/AstroBox-NG

Copyright (C) 2025-2026 AstralSight Studios and contributors.

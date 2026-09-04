import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimeArchive = join(root, 'dist', `expo-abcore-${packageJson.version}.tgz`);
const sourceArchive = join(root, 'dist', `expo-abcore-${packageJson.version}-source.tar.gz`);

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

for (const path of [runtimeArchive, sourceArchive, join(root, 'dist/SHA256SUMS')]) {
  if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}`);
}

const packedManifest = JSON.parse(run('tar', ['-xOf', runtimeArchive, 'package/package.json']));
if (packedManifest.version !== packageJson.version) {
  throw new Error(`Runtime package version mismatch: ${packedManifest.version}`);
}

const runtimeFiles = run('tar', ['-tzf', runtimeArchive]);
for (const required of [
  'package/android/src/main/jniLibs/arm64-v8a/libexpo_abcore.so',
  'package/android/src/main/jniLibs/armeabi-v7a/libexpo_abcore.so',
  'package/android/src/main/jniLibs/x86_64/libexpo_abcore.so',
  'package/ios/Native/ExpoABCoreRust.xcframework/Info.plist',
  'package/THIRD_PARTY_NOTICES.json',
]) {
  if (!runtimeFiles.includes(required)) throw new Error(`Runtime package is missing ${required}`);
}

const sourceFiles = run('tar', ['-tzf', sourceArchive]);
for (const required of [
  `expo_abcore-${packageJson.version}/rust/src/lib.rs`,
  `expo_abcore-${packageJson.version}/rust/vendor/core/Cargo.toml`,
  `expo_abcore-${packageJson.version}/rust/vendor/pb/Cargo.toml`,
  `expo_abcore-${packageJson.version}/rust/vendor/vivo_msgpack/Cargo.toml`,
]) {
  if (!sourceFiles.includes(required)) throw new Error(`Source package is missing ${required}`);
}

const revisions = new Map([
  ['rust/vendor/core', '73d62d9e55ec2ea4391d75efd0984f85e9af72e9'],
  ['rust/vendor/pb', '03a92010056dd41af114f6f46fd612104b27bd7b'],
  ['rust/vendor/vivo_msgpack', 'baa814b3d90454c127008a85ac307acf92b4914f'],
]);
for (const [path, expected] of revisions) {
  const actual = run('git', ['-C', path, 'rev-parse', 'HEAD']);
  if (actual !== expected) throw new Error(`${path} revision mismatch: ${actual}`);
}

run('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: join(root, 'dist') });
console.log(`Verified expo-abcore ${packageJson.version} release artifacts.`);

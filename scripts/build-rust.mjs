import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const rust = join(root, 'rust');
const platform = process.argv[2];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function newestNdk() {
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'ndk'),
    join(homedir(), 'Library/Android/sdk/ndk'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (existsSync(join(candidate, 'toolchains'))) return candidate;
    const versions = readdirSync(candidate).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    const selected = versions.at(-1);
    if (selected) return join(candidate, selected);
  }
  throw new Error('Android NDK was not found');
}

function buildAndroid() {
  const ndk = newestNdk();
  const prebuiltRoot = join(ndk, 'toolchains/llvm/prebuilt');
  const prebuilt = join(prebuiltRoot, readdirSync(prebuiltRoot)[0]);
  const bin = join(prebuilt, 'bin');
  const targets = [
    ['aarch64-linux-android', 'arm64-v8a', 'aarch64-linux-android24-clang'],
    ['armv7-linux-androideabi', 'armeabi-v7a', 'armv7a-linux-androideabi24-clang'],
    ['x86_64-linux-android', 'x86_64', 'x86_64-linux-android24-clang'],
  ];
  run('rustup', ['target', 'add', ...targets.map(([target]) => target)]);
  for (const [target, abi, linkerName] of targets) {
    const linker = join(bin, linkerName);
    const envKey = `CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`;
    run('cargo', ['build', '--release', '--target', target], {
      cwd: rust,
      env: { [envKey]: linker },
    });
    const destination = join(root, 'android/src/main/jniLibs', abi);
    mkdirSync(destination, { recursive: true });
    cpSync(
      join(rust, 'target', target, 'release', 'libexpo_abcore.so'),
      join(destination, 'libexpo_abcore.so'),
    );
  }
}

function buildIos() {
  const targets = [
    'aarch64-apple-ios',
    'aarch64-apple-ios-sim',
    'x86_64-apple-ios',
  ];
  run('rustup', ['target', 'add', ...targets]);
  for (const target of targets) {
    run('cargo', ['build', '--release', '--target', target], { cwd: rust });
  }
  const native = join(root, 'ios/Native');
  const output = join(native, 'ExpoABCoreRust.xcframework');
  const simulator = join(native, 'libexpo_abcore.a');
  rmSync(output, { recursive: true, force: true });
  run('lipo', [
    '-create',
    join(rust, 'target/aarch64-apple-ios-sim/release/libexpo_abcore.a'),
    join(rust, 'target/x86_64-apple-ios/release/libexpo_abcore.a'),
    '-output', simulator,
  ]);
  run('xcodebuild', [
    '-create-xcframework',
    '-library', join(rust, 'target/aarch64-apple-ios/release/libexpo_abcore.a'),
    '-headers', join(native, 'include'),
    '-library', simulator,
    '-headers', join(native, 'include'),
    '-output', output,
  ]);
  rmSync(simulator, { force: true });
}

if (!platform || platform === 'android') buildAndroid();
if (!platform || platform === 'ios') buildIos();

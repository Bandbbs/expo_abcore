import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const version = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(root, 'package.json'), 'utf8'))).version;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
run('pnpm', ['pack', '--pack-destination', dist]);

const packed = readdirSync(dist).find((name) => name.endsWith('.tgz'));
if (!packed) throw new Error('pnpm pack did not create a tarball');
const releasePackage = `expo-abcore-${version}.tgz`;
if (packed !== releasePackage) renameSync(join(dist, packed), join(dist, releasePackage));

const sourceArchive = `expo-abcore-${version}-source.tar.gz`;
const stagingRoot = mkdtempSync(join(tmpdir(), 'expo-abcore-source-'));
const sourceRoot = join(stagingRoot, `expo_abcore-${version}`);
mkdirSync(sourceRoot, { recursive: true });
run('rsync', [
  '-a',
  '--exclude=.git',
  '--exclude=.DS_Store',
  '--exclude=node_modules',
  '--exclude=dist',
  '--exclude=rust/target',
  '--exclude=android/build',
  '--exclude=ios/build',
  '--exclude=example/android',
  '--exclude=example/ios',
  `${root}/`,
  `${sourceRoot}/`,
]);
run('tar', ['-C', stagingRoot, '-czf', join(dist, sourceArchive), basename(sourceRoot)]);
rmSync(stagingRoot, { recursive: true, force: true });

const artifacts = [releasePackage, sourceArchive];
for (const artifact of artifacts) {
  if (!existsSync(join(dist, artifact))) throw new Error(`Missing release artifact: ${artifact}`);
}
const lines = [];
for (const artifact of artifacts) {
  lines.push(`${await sha256(join(dist, artifact))}  ${basename(artifact)}`);
}
writeFileSync(join(dist, 'SHA256SUMS'), `${lines.join('\n')}\n`);

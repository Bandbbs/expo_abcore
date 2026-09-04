import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tarballName = `expo-abcore-${packageJson.version}.tgz`;
const tarballReference = `../dist/${tarballName}`;
const tarball = join(root, 'dist', tarballName);
const lockfile = join(root, 'example', 'pnpm-lock.yaml');
const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
const escapedReference = tarballReference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const resolution = new RegExp(
  `(expo-abcore@file:${escapedReference}:\\n\\s+resolution: \\{integrity: )sha512-[^,}]+(, tarball: file:${escapedReference}\\})`,
  'g',
);
const source = readFileSync(lockfile, 'utf8');
const matches = [...source.matchAll(resolution)];
if (matches.length !== 1) {
  throw new Error(`Expected one ${tarballName} resolution in the example lockfile, found ${matches.length}`);
}
const updated = source.replace(resolution, `$1${integrity}$2`);
writeFileSync(lockfile, updated);
console.log(`Updated ${tarballName} integrity for the clean example install.`);

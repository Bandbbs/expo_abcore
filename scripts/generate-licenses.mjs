import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const licensePattern = /^(?:licen[cs]e|copying|notice|unlicense)(?:[._-].*)?$/i;
const astroBoxPackages = new Map([
  ['corelib', 'https://github.com/AstralSightStudios/AstroBox-NG-Module-Core'],
  ['pb', 'https://github.com/AstralSightStudios/AstroBox-NG-Module-Pb'],
  ['vivo-msgpack', 'https://github.com/AstralSightStudios/AstroBox-NG-Module-Vivo-MsgPack'],
]);
const canonicalLicenseFiles = [
  ['Apache-2.0', 'Apache-2.0.txt'],
  ['BSD-2-Clause', 'BSD-2-Clause.txt'],
  ['BSD-3-Clause', 'BSD-3-Clause.txt'],
  ['MIT', 'MIT.txt'],
];

function canonicalLicenseText(expression) {
  return canonicalLicenseFiles
    .filter(([spdx]) => expression?.includes(spdx))
    .map(([, filename]) => readFileSync(join(root, 'licenses', filename), 'utf8').trim())
    .join('\n\n');
}

function normalizeRepository(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  return raw?.replace(/^git\+/, '').replace(/\.git$/, '');
}

function packageDocuments(directory, explicit) {
  const paths = [];
  if (explicit) paths.push(resolve(directory, explicit));
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (licensePattern.test(entry) && statSync(path).isFile()) paths.push(path);
    }
  }
  return [...new Set(paths)]
    .filter(existsSync)
    .map((path) => readFileSync(path, 'utf8').trim())
    .filter(Boolean);
}

function cargoLicenses() {
  const metadata = JSON.parse(execFileSync('cargo', [
    'metadata', '--manifest-path', join(root, 'rust/Cargo.toml'), '--format-version', '1', '--locked',
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
  const rootPackage = metadata.packages.find((pkg) => pkg.name === 'expo_abcore');
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const runtimePackageIds = new Set();
  const pending = rootPackage ? [rootPackage.id] : [];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || runtimePackageIds.has(id)) continue;
    runtimePackageIds.add(id);
    for (const dependency of nodes.get(id)?.deps || []) {
      const isRuntime = dependency.dep_kinds.some(({ kind }) => kind === null);
      if (isRuntime && !runtimePackageIds.has(dependency.pkg)) pending.push(dependency.pkg);
    }
  }
  return metadata.packages
    .filter((pkg) => pkg.name !== 'expo_abcore' && runtimePackageIds.has(pkg.id))
    .map((pkg) => {
      const documents = packageDocuments(dirname(pkg.manifest_path), pkg.license_file);
      const license = pkg.license || (astroBoxPackages.has(pkg.name)
        ? 'AGPL-3.0-only with additional attribution terms'
        : 'Unknown');
      return {
        id: `rust:${pkg.name}@${pkg.version}:${createHash('sha256').update(pkg.id).digest('hex').slice(0, 8)}`,
        name: pkg.name,
        version: pkg.version,
        license,
        authors: pkg.authors || [],
        repository: pkg.repository || pkg.homepage || astroBoxPackages.get(pkg.name),
        licenseText: documents.join('\n\n') || (astroBoxPackages.has(pkg.name)
          ? readFileSync(join(root, 'ADDITIONAL-TERMS.md'), 'utf8')
          : canonicalLicenseText(license)),
        source: 'rust',
      };
    });
}

function javascriptLicenses() {
  try {
    const grouped = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }));
    const result = [];
    for (const [license, packages] of Object.entries(grouped)) {
      for (const pkg of packages) {
        const paths = pkg.paths || [];
        const versions = pkg.versions || [];
        for (let index = 0; index < Math.max(paths.length, versions.length, 1); index += 1) {
          const packageDir = paths[index] || paths[0];
          const manifest = packageDir && existsSync(join(packageDir, 'package.json'))
            ? JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
            : {};
          result.push({
            id: `javascript:${pkg.name}@${versions[index] || versions[0] || 'unknown'}`,
            name: pkg.name,
            version: versions[index] || versions[0] || 'unknown',
            license,
            authors: [typeof manifest.author === 'string' ? manifest.author : manifest.author?.name].filter(Boolean),
            repository: normalizeRepository(manifest.repository) || manifest.homepage,
            licenseText: (packageDir ? packageDocuments(packageDir).join('\n\n') : '')
              || canonicalLicenseText(license),
            source: 'javascript',
          });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

const project = [
  {
    id: 'project:expo-abcore',
    name: 'expo-abcore',
    version: '0.1.0',
    license: 'AGPL-3.0-only with attribution and authorized-host exception',
    authors: ['Bandbbs', 'AstralSightStudios contributors'],
    repository: 'https://github.com/Bandbbs/expo_abcore',
    licenseText: [
      readFileSync(join(root, 'LICENSE'), 'utf8'),
      readFileSync(join(root, 'ADDITIONAL-TERMS.md'), 'utf8'),
      readFileSync(join(root, 'LINKING-EXCEPTION.md'), 'utf8'),
      readFileSync(join(root, 'AUTHORIZED_HOSTS.md'), 'utf8'),
    ].join('\n\n'),
    source: 'project',
  },
  {
    id: 'project:astrobox-ng',
    name: 'AstroBox-NG',
    version: '2.0.0',
    license: 'AGPL-3.0-only with additional attribution terms',
    authors: ['AstralSightStudios contributors'],
    repository: 'https://github.com/AstralSightStudios/AstroBox-NG',
    licenseText: [
      readFileSync(join(root, 'LICENSE'), 'utf8'),
      readFileSync(join(root, 'ADDITIONAL-TERMS.md'), 'utf8'),
    ].join('\n\n'),
    source: 'project',
  },
  ...[
    ['core', 'AstroBox-NG Module Core', '73d62d9e55ec2ea4391d75efd0984f85e9af72e9', 'https://github.com/AstralSightStudios/AstroBox-NG-Module-Core'],
    ['pb', 'AstroBox-NG Module Pb', '03a92010056dd41af114f6f46fd612104b27bd7b', 'https://github.com/AstralSightStudios/AstroBox-NG-Module-Pb'],
    ['vivo-msgpack', 'AstroBox-NG Vivo MsgPack', 'baa814b3d90454c127008a85ac307acf92b4914f', 'https://github.com/AstralSightStudios/AstroBox-NG-Module-Vivo-MsgPack'],
    ['bluetooth', 'AstroBox-NG Module Bluetooth', '91db36fe93ba3ebeb522f3ed9709ff3c9262a773', 'https://github.com/AstralSightStudios/AstroBox-NG-Module-Bluetooth'],
    ['android-spp', 'AstroBox-NG Android SPP', 'a660701883380ed25cd4c0284c574cb6b83a941b', 'https://github.com/AstralSightStudios/AstroBox-NG-Plugin-BtClassicSpp'],
  ].map(([id, name, version, repository]) => ({
    id: `project:astrobox-${id}`,
    name,
    version,
    license: 'AGPL-3.0-only with additional attribution terms',
    authors: ['AstralSightStudios contributors'],
    repository,
    licenseText: [
      readFileSync(join(root, 'LICENSE'), 'utf8'),
      readFileSync(join(root, 'ADDITIONAL-TERMS.md'), 'utf8'),
    ].join('\n\n'),
    source: 'project',
  })),
];

const native = [
  {
    id: 'android:androidx-core-ktx@1.17.0',
    name: 'AndroidX Core KTX',
    version: '1.17.0',
    license: 'Apache-2.0',
    authors: ['The Android Open Source Project'],
    repository: 'https://cs.android.com/androidx/platform/frameworks/support',
    licenseText: readFileSync(join(root, 'licenses/Apache-2.0.txt'), 'utf8'),
    source: 'android',
  },
  {
    id: 'android:kotlinx-coroutines-android@1.10.2',
    name: 'kotlinx.coroutines Android',
    version: '1.10.2',
    license: 'Apache-2.0',
    authors: ['JetBrains'],
    repository: 'https://github.com/Kotlin/kotlinx.coroutines',
    licenseText: readFileSync(join(root, 'licenses/Apache-2.0.txt'), 'utf8'),
    source: 'android',
  },
];

const items = [...project, ...javascriptLicenses(), ...cargoLicenses(), ...native]
  .filter((item, index, array) => array.findIndex((other) => other.id === item.id) === index)
  .sort((a, b) => {
    const pinnedIds = project.map((item) => item.id);
    const pinned = (value) => {
      const index = pinnedIds.indexOf(value.id);
      return index < 0 ? pinnedIds.length : index;
    };
    return pinned(a) - pinned(b) || a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en');
  });

for (const item of items) {
  if (!item.license || item.license === 'Unknown') {
    throw new Error(`Runtime dependency has no declared license: ${item.name}@${item.version}`);
  }
  if (!item.licenseText?.trim()) {
    throw new Error(`Runtime dependency has no license text: ${item.name}@${item.version}`);
  }
}

const output = `${JSON.stringify(items)}\n`;
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.json'), output);
const androidAssets = join(root, 'android/src/main/assets');
const iosResources = join(root, 'ios/Resources');
mkdirSync(androidAssets, { recursive: true });
mkdirSync(iosResources, { recursive: true });
writeFileSync(join(androidAssets, 'expo_abcore_licenses.json'), output);
writeFileSync(join(iosResources, 'expo_abcore_licenses.json'), output);
console.log(`Generated ${items.length} runtime license entries.`);

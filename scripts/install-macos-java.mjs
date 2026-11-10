// Uses only Node built-ins so it can run before npm install.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function javaMajor(output) {
  const version = output.match(/version "(?:1\.)?(\d+)/);
  return version ? Number(version[1]) : null;
}

function probe(home, major) {
  const result = spawnSync(path.join(home, 'bin/java'), ['-version'], { encoding: 'utf8', timeout: 15000 });
  return result.status === 0 && javaMajor(`${result.stdout}\n${result.stderr}`) === major;
}

export async function installRuntimes(root, machine) {
  const arch = { x86_64: 'x64', arm64: 'aarch64' }[machine];
  if (!arch) throw new Error(`Unsupported Mac architecture: ${machine}`);
  root = path.resolve(root);
  await fs.mkdir(root, { recursive: true });
  for (const major of [8, 11, 16, 17, 21, 25]) {
    const target = path.join(root, String(major));
    const home = path.join(target, 'Contents/Home');
    if (probe(home, major)) {
      console.error(`Java ${major} already installed (${home})`);
      continue;
    }
    const response = await fetch(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jdk&os=mac&vendor=eclipse`, { signal: AbortSignal.timeout(60000) });
    if (major === 16 && [204, 404].includes(response.status)) {
      console.error('Legacy Java 16 is unavailable for this Mac; Minecraft 1.17 needs a separately installed compatible runtime.');
      continue;
    }
    if (!response.ok) throw new Error(`Java ${major} metadata download failed: HTTP ${response.status}`);
    const assets = await response.json();
    const pkg = assets[0]?.binary?.package;
    if (!pkg && major === 16) {
      console.error('Legacy Java 16 is unavailable for this Mac; Minecraft 1.17 needs a separately installed compatible runtime.');
      continue;
    }
    if (!pkg || !/^[a-f0-9]{64}$/i.test(pkg.checksum) || !pkg.link.startsWith('https://')) throw new Error(`Invalid Java ${major} package metadata`);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-java-'));
    const staging = await fs.mkdtemp(path.join(root, `.java-${major}-`));
    try {
      console.error(`Downloading prebuilt Java ${major} (${arch})...`);
      const download = await fetch(pkg.link, { signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (!download.ok || !download.body) throw new Error(`Java ${major} download failed: HTTP ${download.status}`);
      const hash = createHash('sha256');
      const archive = path.join(temp, 'jdk.tar.gz');
      await pipeline(Readable.fromWeb(download.body), new Transform({ transform(chunk, encoding, done) { hash.update(chunk); done(null, chunk); } }), createWriteStream(archive));
      if (hash.digest('hex') !== pkg.checksum.toLowerCase()) throw new Error(`Java ${major} checksum verification failed`);
      const extracted = spawnSync('tar', ['-xzf', archive, '-C', staging, '--strip-components=1'], { stdio: 'inherit' });
      if (extracted.status !== 0) throw new Error(`Java ${major} extraction failed`);
      if (!probe(path.join(staging, 'Contents/Home'), major)) throw new Error(`Java ${major} failed its runtime check`);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(staging, target);
      console.error(`Java ${major} ready (${home})`);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return path.join(root, '25/Contents/Home');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installRuntimes(process.argv[2], process.argv[3]).then(home => console.log(home)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

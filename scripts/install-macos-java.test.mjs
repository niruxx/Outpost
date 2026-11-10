import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { javaMajor, installRuntimes } from './install-macos-java.mjs';

test('recognizes legacy and current java -version output', () => {
  assert.equal(javaMajor('openjdk version "1.8.0_462"'), 8);
  assert.equal(javaMajor('openjdk version "25.0.1" 2025-10-21'), 25);
  assert.equal(javaMajor('java failed to start'), null);
});

test('rejects unsupported architectures before downloading', async () => {
  await assert.rejects(installRuntimes('.', 'unknown'), /Unsupported Mac architecture/);
});

test('checksum failure preserves existing runtime and cleans staging files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-java-test-'));
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, '8'));
    await fs.writeFile(path.join(root, '8/keep.txt'), 'existing runtime');
    globalThis.fetch = async url => String(url).includes('/assets/')
      ? Response.json([{ binary: { package: { link: 'https://example.com/jdk.tar.gz', checksum: '0'.repeat(64) } } }])
      : new Response('invalid archive');
    await assert.rejects(installRuntimes(root, 'x86_64'), /checksum verification failed/);
    assert.equal(await fs.readFile(path.join(root, '8/keep.txt'), 'utf8'), 'existing runtime');
    assert.deepEqual(await fs.readdir(root), ['8']);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});

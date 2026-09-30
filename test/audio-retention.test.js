import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupProcessedAudio } from '../src/voice/audio-retention.js';

for (const [label, options, keep] of [
  ['retains completed audio by default', {}, true],
  ['discards confirmed empty recordings', { empty: true }, false],
  ['supports explicit delete-after-processing', { retainAudio: false }, false],
]) {
  test(label, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parley-retention-'));
    const file = join(dir, 'speaker_0.pcm');
    try {
      await writeFile(file, 'recorded audio');
      await cleanupProcessedAudio(dir, options);
      if (keep) assert.equal(await readFile(file, 'utf8'), 'recorded audio');
      else await assert.rejects(access(dir), { code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

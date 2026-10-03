import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeMeetingWav } from '../src/delivery/meeting-audio.js';

function pcm(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2));
  return bytes;
}
test('meeting WAV preserves capture offsets, overlaps, gaps and exact PCM format across blocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parley-wav-'));
  try {
    const a = join(root, '111_1000.pcm'), original = pcm(Array(16002).fill(1000));
    await writeFile(a, original);
    await writeFile(join(root, '222_2000.pcm'), pcm([2000, -2000]));
    await writeFile(join(root, '333_2001.pcm'), pcm([123, -456]));
    const path = join(root, 'exports', 'meeting.wav');
    assert.equal(await writeMeetingWav(root, path), path);
    const wav = await readFile(path);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 16018 * 2);
    const sample = i => wav.readInt16LE(44 + i * 2);
    assert.equal(sample(0), 1000);
    assert.equal(sample(15999), 1000);
    assert.equal(sample(16000), 3000);
    assert.equal(sample(16001), -1000);
    assert.equal(sample(16002), 0);
    assert.equal(sample(16015), 0);
    assert.equal(sample(16016), 123);
    assert.equal(sample(16017), -456);
    assert.deepEqual(await readFile(a), original);
    assert.deepEqual(await readdir(join(root, 'exports')), ['meeting.wav']);
    for (const name of await readdir(root)) if (name.endsWith('.pcm')) await rm(join(root, name));
    assert.equal(await writeMeetingWav(root, path), path);
    assert.deepEqual(await readFile(path), wav);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('WAV mixing saturates overlapping loud speakers instead of integer wraparound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parley-wav-'));
  try {
    for (const id of ['111', '222']) await writeFile(join(root, `${id}_1000.pcm`), pcm([30000, -30000]));
    const path = join(root, 'meeting.wav');
    await writeMeetingWav(root, path);
    const wav = await readFile(path);
    assert.equal(wav.readInt16LE(44), 32767);
    assert.equal(wav.readInt16LE(46), -32768);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('WAV export handles unavailable audio and rejects truncated samples and oversized timelines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parley-wav-'));
  try {
    const audio = join(root, 'audio'), path = join(root, 'meeting.wav');
    assert.equal(await writeMeetingWav(audio, path), null);
    await mkdir(audio);
    await writeFile(join(audio, '111_1000.pcm'), 'abc');
    await assert.rejects(writeMeetingWav(audio, path), /Incomplete PCM/);
    await writeFile(join(audio, '111_1000.pcm'), pcm([1]));
    await writeFile(join(audio, '222_200000000.pcm'), pcm([1]));
    await assert.rejects(writeMeetingWav(audio, path), /too long/);
    assert.deepEqual(await readdir(root), ['audio']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

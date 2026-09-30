// test/reconcile.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { reconcileOnBoot } from '../src/store/reconcile.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'parley-reconcile-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const quiet = { warn: () => {}, log: () => {} };

test('reconcileOnBoot marks mid-pipeline meetings transcription_failed', async () => {
  const { dir, cleanup } = tmp();
  try {
    const db = openDb(':memory:');
    const rec = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    const proc = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    db.setMeetingStatus(proc, 'processing');
    const done = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    db.setMeetingStatus(done, 'done');

    const r = await reconcileOnBoot(db, join(dir, 'audio'), { log: quiet });
    assert.equal(r.orphanMeetings, 2);
    assert.equal(db.getMeeting(rec).status, 'transcription_failed');
    assert.equal(db.getMeeting(proc).status, 'transcription_failed');
    assert.equal(db.getMeeting(done).status, 'done'); // untouched
  } finally { cleanup(); }
});

test('reconcileOnBoot sweeps audio dirs for gone/terminal meetings, keeps retryable', async () => {
  const { dir, cleanup } = tmp();
  try {
    const db = openDb(':memory:');
    const audioRoot = join(dir, 'audio');
    // done → sweep; deleted (no row) → sweep; transcription_failed → keep.
    const doneId = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    db.setMeetingStatus(doneId, 'done');
    const failId = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
    db.setMeetingStatus(failId, 'transcription_failed');
    const goneId = 9999; // no such meeting

    for (const id of [doneId, failId, goneId]) {
      const d = join(audioRoot, String(id));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'u1_0.pcm'), 'x');
    }
    // A non-numeric dir we didn't create must be left alone.
    mkdirSync(join(audioRoot, 'notes'), { recursive: true });

    const r = await reconcileOnBoot(db, audioRoot, { log: quiet, retainAudio: false });
    assert.equal(r.sweptDirs, 2);
    assert.equal(existsSync(join(audioRoot, String(doneId))), false);
    assert.equal(existsSync(join(audioRoot, String(goneId))), false);
    assert.equal(existsSync(join(audioRoot, String(failId))), true); // kept for retry
    assert.equal(existsSync(join(audioRoot, 'notes')), true);        // untouched
  } finally { cleanup(); }
});

test('reconcileOnBoot is a no-op when the audio root does not exist', async () => {
  const db = openDb(':memory:');
  const r = await reconcileOnBoot(db, '/nonexistent/parley/audio', { log: quiet });
  assert.equal(r.sweptDirs, 0);
  assert.equal(r.orphanMeetings, 0);
});

test('retention keeps complete and partial recordings across restart, but sweeps deleted audio', async () => {
  const { dir, cleanup } = tmp();
  const db = openDb(':memory:');
  try {
    for (const complete of [true, false]) {
      const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'x', startedAt: 't' });
      db.setMeetingStatus(id, 'done');
      db.setTranscriptionComplete(id, complete);
      mkdirSync(join(dir, String(id)));
      writeFileSync(join(dir, String(id), 'speaker_0.pcm'), 'recorded audio');
    }
    mkdirSync(join(dir, '9999'));
    await reconcileOnBoot(db, dir, { log: quiet, retainAudio: true });
    assert.ok(existsSync(join(dir, '1', 'speaker_0.pcm')));
    assert.ok(existsSync(join(dir, '2', 'speaker_0.pcm')));
    assert.equal(existsSync(join(dir, '9999')), false);
  } finally { db.sql.close(); cleanup(); }
});

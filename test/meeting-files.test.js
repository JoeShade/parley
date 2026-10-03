import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store/db.js';
import { prepareMeetingFiles } from '../src/delivery/meeting-files.js';

test('file manifest refreshes both exports and locates retained PCM without changing audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parley-files-')), db = openDb(':memory:');
  try {
    const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'Call', startedAt: '2026-10-03T12:00:00Z' });
    db.setMeetingStatus(id, 'done');
    db.addUtterance({ meetingId: id, userId: '123', displayName: 'Alice', startMs: Date.parse('2026-10-03T12:00:01Z'), endMs: Date.parse('2026-10-03T12:00:02Z'), text: 'Hello' });
    const audio = join(root, 'audio', String(id));
    await mkdir(audio, { recursive: true });
    await writeFile(join(audio, '123_0.pcm'), 'original audio');
    const files = await prepareMeetingFiles(db, id, { dataDir: root, exportDir: join(root, 'exports') });
    assert.equal(files.audio, audio);
    const wav = await readFile(files.exports.wav);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.subarray(44).toString(), 'original audio');
    assert.match(await readFile(files.exports.markdown, 'utf8'), /Alice:\*\* Hello/);
    assert.equal(JSON.parse(await readFile(files.exports.json, 'utf8')).utterances[0].user_id, '123');
    assert.equal(await readFile(join(audio, '123_0.pcm'), 'utf8'), 'original audio');
    await rm(audio, { recursive: true });
    assert.equal((await prepareMeetingFiles(db, id, { dataDir: root, exportDir: join(root, 'exports') })).audio, null);
    db.setMeetingStatus(id, 'processing');
    await assert.rejects(prepareMeetingFiles(db, id), /processing/);
    await assert.rejects(prepareMeetingFiles(db, -1), /Invalid meeting ID/);
    await assert.rejects(prepareMeetingFiles(db, 999), /not found/);
  } finally { db.sql.close(); await rm(root, { recursive: true, force: true }); }
});

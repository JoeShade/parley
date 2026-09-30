import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { openDb } from '../src/store/db.js';
import { config } from '../src/config/env.js';
import { processMeeting } from '../src/pipeline/orchestrator.js';
import { retryMeeting } from '../src/pipeline/retry.js';
import { apiRouter } from '../src/web/api.js';
import { readMeetingExport, meetingExportBasename, writeMeetingExports } from '../src/delivery/meeting-export.js';

let root, db, previous;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'parley-export-'));
  db = openDb(':memory:');
  previous = { exportDir: config.exportDir, autoExport: config.autoExport };
  config.exportDir = join(root, 'exports');
  config.autoExport = true;
});
afterEach(async () => {
  db.sql.close();
  Object.assign(config, previous);
  await rm(root, { recursive: true, force: true });
});

const epoch = Date.parse('2026-09-30T23:59:58.000Z');
function seed(guild = 'g') {
  const id = db.createMeeting({ guildId: guild, channelId: 'c', channelName: 'Planning', startedAt: new Date(epoch).toISOString() });
  // Deliberately identical display names: JSON must retain distinct identities.
  db.addAttendee(id, '111', 'Alex');
  db.addAttendee(id, '222', 'Alex');
  db.setMeetingStatus(id, 'processing', new Date(epoch + 20000).toISOString());
  db.sql.prepare('INSERT OR IGNORE INTO guild_config (guild_id, summarizer_provider) VALUES (?, ?)').run(guild, 'fake');
  return id;
}
function options(extra = {}) {
  return {
    cfg: { summarizerProvider: 'fake' }, tracks: [{}, {}],
    transcribe: async () => ({ utterances: [
      { userId: '222', displayName: 'Alex', startMs: epoch + 6500, endMs: epoch + 7500, text: 'Second café 😊' },
      { userId: '111', displayName: 'Alex', startMs: epoch + 341, endMs: epoch + 500, text: 'First' },
    ], failures: [] }),
    ...extra,
  };
}
async function readPair(id) {
  const basename = meetingExportBasename(db.getMeeting(id));
  return {
    json: JSON.parse(await readFile(join(config.exportDir, `${basename}.json`), 'utf8')),
    md: await readFile(join(config.exportDir, `${basename}.md`), 'utf8'),
  };
}

test('completion writes both formats with exact IDs, chronological UTC timings and full notes', async () => {
  const id = seed();
  const result = await processMeeting(db, id, options());
  assert.equal(result.exported, true);
  assert.equal(result.exportError, null);
  const { json, md } = await readPair(id);
  assert.equal(json.meeting.status, 'done');
  assert.equal(json.meeting.ended_at, new Date(epoch + 20000).toISOString());
  assert.deepEqual(json.utterances.map((u) => u.user_id), ['111', '222']);
  assert.equal(json.utterances[0].start_ms, epoch + 341);
  assert.ok(json.summary.notes.tldr);
  assert.ok(md.includes(json.summary.notes.tldr));
  assert.ok(md.includes('[2026-09-30T23:59:58.341Z] Alex:** First'));
  assert.ok(md.includes('[2026-10-01T00:00:04.500Z] Alex:** Second café 😊'));
  assert.ok(md.indexOf('Alex:** First') < md.indexOf('Alex:** Second'));
  assert.equal((await readdir(config.exportDir)).length, 2);
  if (process.platform !== 'win32') assert.equal((await stat(result.exports.json)).mode & 0o777, 0o600);
});

test('summary failure archives transcript and retry refreshes the same pair', async () => {
  const id = seed();
  await assert.rejects(processMeeting(db, id, options({
    summarizer: { summarize: async () => { throw new Error('offline'); } },
  })), /offline/);
  const first = await readPair(id);
  assert.equal(first.json.meeting.status, 'summary_failed');
  assert.equal(first.json.summary, null);
  assert.equal(first.json.utterances.length, 2);
  assert.match(first.md, /Summarisation failed/);
  const result = await retryMeeting(db, id, { dataDir: root });
  assert.equal(result.exported, true);
  const second = await readPair(id);
  assert.equal(second.json.meeting.status, 'done');
  assert.ok(second.json.summary.notes.tldr);
  assert.doesNotMatch(second.md, /Summarisation failed/);
  assert.equal((await readdir(config.exportDir)).length, 2);
});

test('partial transcripts are marked and exported even if Discord posting fails', async () => {
  const id = seed();
  const normal = options();
  const result = await processMeeting(db, id, options({
    transcribe: async () => ({ ...(await normal.transcribe()), failures: [{ userId: '333', error: 'bad audio' }] }),
    deliver: async () => { throw new Error('missing permissions'); },
  }));
  assert.equal(result.delivered, false);
  assert.equal(result.exported, true);
  const { json, md } = await readPair(id);
  assert.equal(json.meeting.transcription_complete, 0);
  assert.match(md, /Transcript is incomplete/);
});

test('empty recordings and total transcription failures do not create archives', async () => {
  const empty = seed();
  const result = await processMeeting(db, empty, options({ transcribe: async () => [] }));
  assert.equal(result.empty, true);
  const failed = seed();
  await assert.rejects(processMeeting(db, failed, options({
    transcribe: async () => ({ utterances: [], failures: [{ error: 'offline' }] }),
  })), /All 1 track/);
  await assert.rejects(readdir(config.exportDir), { code: 'ENOENT' });
});

test('archive write failure preserves done status and allows Discord delivery, then can be retried', async () => {
  const id = seed();
  await writeFile(config.exportDir, 'blocking file');
  let delivered = false;
  const result = await processMeeting(db, id, options({ deliver: async () => { delivered = true; } }));
  assert.equal(result.exported, false);
  assert.ok(result.exportError);
  assert.equal(db.getMeeting(id).status, 'done');
  assert.ok(db.getSummary(id));
  assert.equal(delivered, true);
  await rm(config.exportDir);
  await writeMeetingExports(db, id);
  assert.equal((await readPair(id)).json.utterances.length, 2);
});

test('disabled automatic exports leave the manual exporter available', async () => {
  const id = seed();
  config.autoExport = false;
  const result = await processMeeting(db, id, options());
  assert.equal(result.exported, false);
  assert.equal(result.exportError, null);
  await assert.rejects(readdir(config.exportDir), { code: 'ENOENT' });
  await writeMeetingExports(db, id);
  assert.equal((await readdir(config.exportDir)).length, 2);
});

test('same-day concurrent meetings produce separate pairs without temporary leftovers', async () => {
  const a = seed('g1'), b = seed('g2');
  const results = await Promise.all([processMeeting(db, a, options()), processMeeting(db, b, options())]);
  assert.ok(results.every((r) => r.exported));
  const names = await readdir(config.exportDir);
  assert.equal(names.length, 4);
  assert.ok(names.every((n) => /\.(md|json)$/.test(n)));
  assert.equal((await readPair(a)).json.meeting.guild_id, 'g1');
  assert.equal((await readPair(b)).json.meeting.guild_id, 'g2');
});

test('failed replacement reports the error and cleans up staged temporary files', async () => {
  const id = seed();
  await processMeeting(db, id, options());
  const basename = meetingExportBasename(db.getMeeting(id));
  const mdPath = join(config.exportDir, `${basename}.md`);
  const jsonPath = join(config.exportDir, `${basename}.json`);
  const originalJson = await readFile(jsonPath, 'utf8');
  await rm(mdPath);
  await mkdir(mdPath); // Cannot rename a file over a directory.
  await assert.rejects(writeMeetingExports(db, id));
  assert.equal(await readFile(jsonPath, 'utf8'), originalJson);
  assert.equal((await readdir(config.exportDir)).length, 2);
});

test('archive filenames cannot include channel names or unsafe date paths', () => {
  assert.equal(meetingExportBasename({ id: 42, started_at: '../../escape', channel_name: '../secret' }), 'meeting-42-undated');
  assert.throws(() => meetingExportBasename({ id: '../escape' }), /Invalid meeting ID/);
  assert.throws(() => readMeetingExport(db, 999), /not found/);
});

test('dashboard downloads match the automatic files', async () => {
  const id = seed();
  await processMeeting(db, id, options());
  const archived = await readPair(id);
  const app = express();
  app.use('/api', apiRouter({ db }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/meetings/${id}/export`;
  try {
    assert.deepEqual(await (await fetch(url)).json(), archived.json);
    assert.equal(await (await fetch(`${url}?format=md`)).text(), archived.md);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('CLI regenerates both files from persistent SQLite without STT or a summarizer', async () => {
  const disk = openDb(join(root, 'meetings.db'));
  const id = disk.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'General', startedAt: new Date(epoch).toISOString() });
  disk.addUtterance({ meetingId: id, userId: '111', displayName: 'Alex', startMs: epoch, endMs: epoch + 1000, text: 'Saved text' });
  disk.sql.close();
  const result = spawnSync(process.execPath, ['scripts/export-meeting.mjs', String(id)], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, DATA_DIR: root, PARLEY_ENV_FILE: join(root, '.env'), EXPORT_DIR: config.exportDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(await readFile(join(config.exportDir, 'meeting-1-2026-09-30.json'), 'utf8'));
  assert.equal(data.utterances[0].text, 'Saved text');
  assert.ok((await readdir(config.exportDir)).some((n) => n.endsWith('.md')));
});

test('transcript-only mode exports without calling any summarizer or delivering AI notes', async () => {
  const id = seed();
  const result = await processMeeting(db, id, options({
    cfg: { summarizerProvider: 'none', summarizerFallbackProvider: 'gemini' },
    summarizer: { summarize() { assert.fail('summarizer must not run'); } },
    deliver() { assert.fail('AI notes must not be delivered'); },
  }));
  assert.equal(result.transcriptOnly, true);
  assert.equal(result.empty, false);
  const { json, md } = await readPair(id);
  assert.equal(json.meeting.status, 'done');
  assert.equal(json.summary, null);
  assert.deepEqual(json.utterances.map(u => u.user_id), ['111', '222']);
  assert.ok(md.includes('[2026-09-30T23:59:58.341Z] Alex:** First'));
  assert.ok(!md.includes('Summarisation failed'));
});

test('transcript-only retry clears previous notes and refreshes both archives without AI', async () => {
  const id = seed();
  await processMeeting(db, id, options());
  db.sql.prepare("UPDATE guild_config SET summarizer_provider = 'none' WHERE guild_id = 'g'").run();
  const result = await retryMeeting(db, id, { dataDir: root, deliver() { assert.fail('no AI delivery'); } });
  assert.equal(result.ok, true);
  const { json, md } = await readPair(id);
  assert.equal(json.summary, null);
  assert.equal(json.meeting.status, 'done');
  assert.equal(json.utterances.length, 2);
  assert.ok(md.includes('Second café'));
});

test('missing summarizer credentials no longer prevent transcription and export', async () => {
  const id = seed();
  const old = config.gemini.apiKey;
  config.gemini.apiKey = '';
  try {
    await assert.rejects(processMeeting(db, id, options({ cfg: { summarizerProvider: 'gemini' } })), /GEMINI_API_KEY/);
    const { json } = await readPair(id);
    assert.equal(json.meeting.status, 'summary_failed');
    assert.equal(json.utterances.length, 2);
  } finally { config.gemini.apiKey = old; }
});

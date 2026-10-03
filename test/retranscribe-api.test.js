import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/store/db.js';
import { setGuildConfig } from '../src/store/config.js';
import { config } from '../src/config/env.js';
import { apiRouter } from '../src/web/api.js';

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
function appWith(db, options = {}) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    req.authResolved = true; req.user = { isAdmin: req.headers['x-user'] !== 'viewer' }; next();
  });
  app.use('/api', apiRouter({ db, ...options }));
  return app;
}
function seed(db) {
  const start = Date.parse('2026-10-03T12:00:00Z');
  const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'Call', startedAt: new Date(start).toISOString() });
  db.addAttendee(id, '123', 'Alice');
  db.addUtterance({ meetingId: id, userId: '123', displayName: 'Alice', startMs: start, endMs: start + 1000, text: 'old transcript' });
  db.setMeetingStatus(id, 'done', new Date(start + 1000).toISOString());
  db.setTranscriptionComplete(id, true);
  setGuildConfig(db, 'g', { summarizerProvider: 'none', whisperModel: 'large-v3', language: 'en', autoJoin: false });
  return { id, start };
}

test('a rejected background retranscription leaves a recoverable failed status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parley-rerun-')), old = config.dataDir;
  config.dataDir = root;
  const db = openDb(':memory:'), { id } = seed(db);
  await mkdir(join(root, 'audio', String(id)), { recursive: true });
  await writeFile(join(root, 'audio', String(id), '123_0.pcm'), 'audio');
  const api = await serve(appWith(db, { retranscribe: async () => ({ ok: false, reason: 'Recording unavailable' }) }));
  try {
    assert.equal((await fetch(`${api.base}/api/meetings/${id}/retranscribe`, { method: 'POST' })).status, 202);
    await waitUntil(() => db.getMeeting(id).status === 'transcription_failed');
    assert.equal(db.listUtterances(id)[0].text, 'old transcript');
  } finally { api.close(); db.sql.close(); config.dataDir = old; await rm(root, { recursive: true, force: true }); }
});
async function waitUntil(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Background transcription did not finish.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('retranscription forces STT for a completed transcript, uses current model and refreshes both exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parley-rerun-')), db = openDb(':memory:');
  const old = { dataDir: config.dataDir, exportDir: config.exportDir, sttUrl: config.sttUrl, autoExport: config.autoExport, retainAudio: config.retainAudio };
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let requests = 0;
  const sttApp = express(); sttApp.use(express.raw({ type: '*/*' }));
  sttApp.post('/transcribe', async (req, res) => {
    requests++;
    assert.match(req.body.toString(), /large-v3/);
    assert.match(req.body.toString(), /RIFF/);
    entered(); await gate;
    res.json({ text: 'new accurate transcript', words: [{ word: 'new', start: 0, end: 1 }] });
  });
  const stt = await serve(sttApp);
  Object.assign(config, { dataDir: root, exportDir: join(root, 'exports'), sttUrl: stt.base, autoExport: true, retainAudio: true });
  const { id, start } = seed(db), audio = join(root, 'audio', String(id));
  await mkdir(audio, { recursive: true });
  const pcm = join(audio, `123_${start}.pcm`);
  await writeFile(pcm, Buffer.alloc(32000));
  const api = await serve(appWith(db));
  try {
    const detail = await (await fetch(`${api.base}/api/meetings/${id}`)).json();
    assert.equal(detail.retranscription.eligible, true);
    assert.equal(detail.retranscription.model, 'large-v3');
    assert.equal(detail.files.openUrl, `parley-files://meeting/${id}`);
    const r = await fetch(`${api.base}/api/meetings/${id}/retranscribe`, { method: 'POST' });
    assert.equal(r.status, 202); await started;
    for (const action of ['retranscribe', 'retry']) {
      assert.equal((await fetch(`${api.base}/api/meetings/${id}/${action}`, { method: 'POST' })).status, 409);
    }
    assert.equal((await fetch(`${api.base}/api/meetings/${id}`, { method: 'DELETE' })).status, 409);
    release(); await waitUntil(() => db.getMeeting(id).status === 'done');
    assert.equal(requests, 1);
    assert.equal(db.listUtterances(id)[0].text, 'new accurate transcript');
    assert.equal(db.listUtterances(id)[0].user_id, '123');
    assert.equal((await readFile(pcm)).length, 32000);
    const prefix = join(config.exportDir, `meeting-${id}-2026-10-03`);
    assert.match(await readFile(prefix + '.md', 'utf8'), /new accurate transcript/);
    assert.equal((await readFile(prefix + '.wav')).length, 32044);
    assert.equal(JSON.parse(await readFile(prefix + '.json', 'utf8')).utterances[0].text, 'new accurate transcript');
  } finally { release(); api.close(); stt.close(); Object.assign(config, old); db.sql.close(); await rm(root, { recursive: true, force: true }); }
});

test('retranscription rejects non-admins, missing audio and active recordings without replacing a transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parley-rerun-')), old = config.dataDir;
  config.dataDir = root;
  const db = openDb(':memory:'), { id } = seed(db), api = await serve(appWith(db));
  try {
    const url = `${api.base}/api/meetings/${id}/retranscribe`;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'x-user': 'viewer' } })).status, 403);
    assert.equal((await fetch(url, { method: 'POST' })).status, 409);
    assert.equal(db.listUtterances(id)[0].text, 'old transcript');
    assert.equal((await fetch(`${api.base}/api/meetings/999/retranscribe`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${api.base}/api/meetings/invalid/retranscribe`, { method: 'POST' })).status, 400);
    await mkdir(join(root, 'audio', String(id)), { recursive: true });
    await writeFile(join(root, 'audio', String(id), '123_0.pcm'), 'audio');
    db.setMeetingStatus(id, 'recording');
    assert.equal((await fetch(url, { method: 'POST' })).status, 409);
  } finally { api.close(); db.sql.close(); config.dataDir = old; await rm(root, { recursive: true, force: true }); }
});

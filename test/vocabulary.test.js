import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { openDb } from '../src/store/db.js';
import { normalizeVocabulary, getVocabulary, setVocabulary } from '../src/store/vocabulary.js';
import { processMeeting } from '../src/pipeline/orchestrator.js';
import { apiRouter } from '../src/web/api.js';
import { createSidecarSTT } from '../src/adapters/stt/sidecar.js';
import { createOpenAICompatibleSTT } from '../src/adapters/stt/openai-compatible.js';

test('vocabulary is a literal one-term-per-line list with no Markdown rules', () => {
  assert.equal(normalizeVocabulary('\ufeff  AWP\r\n\r\nconnector\r\nAWP\r\nZywOo\n'), 'AWP\nconnector\nZywOo');
  assert.equal(normalizeVocabulary('#literal term\n- another term'), '#literal term\n- another term');
  assert.equal(normalizeVocabulary(''), '');
  for (const text of [null, 5, 'x'.repeat(65537), '\0', '\ufffd']) assert.throws(() => normalizeVocabulary(text));
});

test('global vocabulary persists on reopen and is used by meetings from different servers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parley-vocabulary-'));
  let db = openDb(join(root, 'meetings.db'));
  try {
    assert.equal(getVocabulary(db), '');
    setVocabulary(db, 'AWP\nconnector');
    db.sql.close(); db = openDb(join(root, 'meetings.db'));
    assert.equal(getVocabulary(db), 'AWP\nconnector');
    for (const guildId of ['server-one', 'server-two']) {
      const id = db.createMeeting({ guildId, channelId: 'c', channelName: 'Match', startedAt: new Date().toISOString() });
      await processMeeting(db, id, { tracks: [], cfg: { summarizerProvider: 'none' },
        transcribe: async (_tracks, cfg) => { assert.equal(cfg.transcriptionVocabulary, 'AWP\nconnector'); return []; } });
    }
    setVocabulary(db, '');
    assert.equal(getVocabulary(db), '');
  } finally { db.sql.close(); await rm(root, { recursive: true, force: true }); }
});

test('global vocabulary API imports, replaces and clears; rejected uploads preserve saved terms', async () => {
  const db = openDb(':memory:'), app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authResolved = true; req.user = { isAdmin: req.headers['x-user'] !== 'viewer' }; next(); });
  app.use('/api', apiRouter({ db }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/vocabulary`;
  const put = (text, viewer = false) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...(viewer ? { 'x-user': 'viewer' } : {}) }, body: JSON.stringify({ text }) });
  try {
    assert.equal((await (await put('AWP\nconnector')).json()).vocabulary, 'AWP\nconnector');
    assert.equal((await put('forbidden', true)).status, 403);
    assert.equal((await put(null)).status, 400);
    assert.equal((await put('x'.repeat(65537))).status, 400);
    assert.equal((await (await fetch(url)).json()).vocabulary, 'AWP\nconnector');
    await put('rotate');
    assert.equal(getVocabulary(db), 'rotate');
    await put(''); assert.equal(getVocabulary(db), '');
  } finally { await new Promise(resolve => server.close(resolve)); db.sql.close(); }
});

test('STT adapters send vocabulary hints and omit them when the list is empty', async () => {
  for (const [create, field] of [[createSidecarSTT, 'vocabulary'], [createOpenAICompatibleSTT, 'prompt']]) {
    const bodies = [];
    const stt = create({ baseUrl: 'http://stt', apiKey: 'test' }, {
      readFile: async () => Buffer.from('audio'),
      fetchImpl: async (_url, opts) => { bodies.push(opts.body); return { ok: true, json: async () => ({ text: 'AWP', words: [] }) }; },
    });
    await stt('audio.wav', { vocabulary: 'AWP, connector' });
    await stt('audio.wav', { vocabulary: '' });
    assert.equal(bodies[0].get(field), 'AWP, connector');
    assert.equal(bodies[1].get(field), null);
  }
});

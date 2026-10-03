import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingNickname } from '../src/voice/recording-nickname.js';

function member(nickname = null) {
  return { guild: { id: 'g' }, nickname,
    user: { username: 'BigBrother' },
    get displayName() { return this.nickname || this.user.username; },
    calls: [], async setNickname(value) { this.calls.push(value); this.nickname = value; } };
}

test('recording uses the bot name and restores no-nickname state on leave', async () => {
  const update = createRecordingNickname(), bot = member();
  await update(bot, true);
  assert.equal(bot.nickname, '[REC] BigBrother');
  await update(bot, false);
  assert.equal(bot.nickname, null);
});

test('custom server name is preserved through repeated joins and stops', async () => {
  const update = createRecordingNickname(), bot = member('Meeting Scribe');
  await update(bot, true); await update(bot, true);
  assert.equal(bot.nickname, '[REC] Meeting Scribe');
  assert.equal(bot.calls.length, 1);
  await update(bot, false);
  assert.equal(bot.nickname, 'Meeting Scribe');
});

test('rapid join and leave serialize Discord writes and restore the name', async () => {
  const update = createRecordingNickname(), bot = member('Custom');
  await Promise.all([update(bot, true), update(bot, false)]);
  assert.deepEqual(bot.calls, ['[REC] Custom', 'Custom']);
});

test('long name respects the nickname limit and keeps the original for restoration', async () => {
  const original = 'x'.repeat(32), bot = member(original), update = createRecordingNickname();
  await update(bot, true);
  assert.equal(bot.nickname.length, 32);
  await update(bot, false);
  assert.equal(bot.nickname, original);
});

test('failed Discord update does not break the next nickname operation', async () => {
  const bot = member('Custom'), update = createRecordingNickname();
  const setter = bot.setNickname;
  bot.setNickname = async () => { throw new Error('missing permission'); };
  await assert.rejects(update(bot, true), /missing permission/);
  bot.setNickname = setter;
  await update(bot, false);
  assert.equal(bot.nickname, 'Custom');
});

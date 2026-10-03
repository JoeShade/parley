// Serialize nickname changes per guild so a quick join/leave restores the name
// even when Discord's first nickname request is still in flight.
export function createRecordingNickname() {
  const states = new Map();
  return function setRecordingNickname(member, recording) {
    if (!member) return Promise.resolve();
    const id = member.guild.id;
    let state = states.get(id);
    if (!state) {
      state = { original: undefined, pending: Promise.resolve() };
      states.set(id, state);
    }
    const task = state.pending.catch(() => {}).then(async () => {
      if (recording) {
        if (state.original === undefined) state.original = member.nickname ?? null;
        const name = String(member.displayName || member.user.globalName || member.user.username)
          .replace(/^(?:\[REC\]\s*)+/, '');
        // Discord nicknames are limited to 32 characters. Keep Unicode intact.
        const nickname = '[REC] ' + Array.from(name).slice(0, 26).join('');
        if (member.nickname !== nickname) await member.setNickname(nickname);
      } else if (state.original !== undefined) {
        const original = state.original;
        await member.setNickname(original);
        state.original = undefined;
      }
    });
    state.pending = task;
    return task;
  };
}

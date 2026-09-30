import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { renderNotes } from './discord-notes.js';

// One snapshot/renderer for both dashboard downloads and automatic archives.
// Preserve the existing JSON schema, including Discord IDs and raw timestamps.
export function readMeetingExport(db, meetingId) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting ${meetingId} not found.`);
  return {
    meeting,
    summary: db.getSummary(meetingId),
    attendees: db.listAttendees(meetingId).map((a) => a.display_name),
    utterances: db.listUtterances(meetingId),
  };
}

export function meetingExportBasename(meeting) {
  // Never put channel/display names or unchecked date text into a file path.
  if (!Number.isSafeInteger(meeting.id) || meeting.id < 1) throw new Error('Invalid meeting ID.');
  const date = /^\d{4}-\d{2}-\d{2}/.exec(meeting.started_at || '')?.[0] || 'undated';
  return `meeting-${meeting.id}-${date}`;
}

export function renderMeetingMarkdown({ meeting, summary, attendees, utterances }) {
  const date = (meeting.started_at || '').slice(0, 10);
  const lines = [`# ${meeting.channel_name || 'Meeting'} — ${date}`, ''];
  if (attendees.length) lines.push(`**Attendees:** ${attendees.join(', ')}`, '');
  if (meeting.started_at) lines.push(`**Started:** ${meeting.started_at}`, '');
  if (meeting.ended_at) lines.push(`**Ended:** ${meeting.ended_at}`, '');
  lines.push(`**Status:** ${meeting.status}`, '');
  if (meeting.transcription_complete === 0) {
    lines.push('> Transcript is incomplete: one or more audio tracks could not be transcribed.', '');
  }
  if (meeting.status === 'summary_failed') {
    lines.push('> Summarisation failed. The available transcript is preserved below.', '');
  } else if (summary?.notes) {
    lines.push(renderNotes(summary.notes, summary.talktime || [],
      { channelName: meeting.channel_name, date: meeting.started_at }), '');
  }
  lines.push('## Full transcript', '', '_Timestamps are UTC capture times._', '');
  for (const u of utterances) {
    // Capture uses Date.now(): start_ms is Unix milliseconds, not elapsed time.
    const timestamp = new Date(u.start_ms).toISOString();
    lines.push(`**[${timestamp}] ${u.display_name}:** ${u.text}`);
  }
  return lines.join('\n') + '\n';
}

export async function writeMeetingExports(db, meetingId, { directory = config.exportDir } = {}) {
  const data = readMeetingExport(db, meetingId);
  const basename = meetingExportBasename(data.meeting);
  const files = {
    markdown: join(directory, `${basename}.md`),
    json: join(directory, `${basename}.json`),
  };
  const contents = [renderMeetingMarkdown(data), JSON.stringify(data, null, 2) + '\n'];
  const destinations = [files.markdown, files.json];
  const temporary = destinations.map((path) => `${path}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    // Stage both before replacing either. Each rename is atomic; the pair is
    // not a filesystem transaction (a crash between renames needs a re-export).
    for (let i = 0; i < temporary.length; i++) {
      await writeFile(temporary[i], contents[i], { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    for (let i = 0; i < temporary.length; i++) await rename(temporary[i], destinations[i]);
  } finally {
    await Promise.all(temporary.map((path) => rm(path, { force: true }).catch(() => {})));
  }
  return files;
}

// Archiving must not undo a saved transcript/summary or prevent Discord delivery.
export async function autoExportMeeting(db, meetingId, {
  directory = config.exportDir, enabled = config.autoExport, log = console,
} = {}) {
  if (!enabled) return { exported: false, exportError: null };
  try {
    const exports = await writeMeetingExports(db, meetingId, { directory });
    log.log(`[export] meeting ${meetingId}: saved Markdown and JSON to ${directory}`);
    return { exported: true, exports, exportError: null };
  } catch (err) {
    const exportError = err.message || String(err);
    log.error(`[export] meeting ${meetingId}: ${exportError}. Transcript remains in SQLite; retry with node scripts/export-meeting.mjs ${meetingId}`);
    return { exported: false, exportError };
  }
}

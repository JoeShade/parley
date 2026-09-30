// src/store/reconcile.js
// Boot-time housekeeping that must run whether or not the Discord bot starts
// (web-only mode still needs it). Two jobs:
//
//   1. Orphaned meetings — rows left in 'recording'/'processing' by a crash mid-
//      pipeline. Mark them 'transcription_failed' so the dashboard offers a retry
//      (the PCM is usually still on disk) instead of stranding them forever.
//   2. Orphaned audio dirs — data/audio/<id> directories whose meeting is gone
//      (deleted) or confirmed empty. Finished audio is retained by default;
//      RETAIN_AUDIO=0 also sweeps completed meetings.
//
// Pure-ish: fs access is injectable for tests.
import { config } from '../config/env.js';
import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

// Statuses whose meeting still needs its audio (a retry may retranscribe from PCM).
const KEEP_AUDIO_STATUSES = new Set(['recording', 'processing', 'transcription_failed', 'summary_failed']);

export async function reconcileOnBoot(db, audioRoot, { readdir = readdirSync, remove = rm, log = console, retainAudio = config.retainAudio } = {}) {
  const result = { orphanMeetings: 0, sweptDirs: 0 };

  // 1) Orphaned meetings from a crash mid-pipeline.
  for (const m of db.findOrphanedMeetings()) {
    db.setMeetingStatus(m.id, 'transcription_failed');
    result.orphanMeetings += 1;
    log.warn?.(`[reconcile] meeting ${m.id} was mid-pipeline at last shutdown → transcription_failed (retry from the dashboard).`);
  }

  // 2) Sweep audio dirs that no live/failed meeting still needs.
  let dirs = [];
  try { dirs = readdir(audioRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { dirs = []; } // no audio root yet → nothing to sweep

  for (const name of dirs) {
    const id = Number(name);
    if (!Number.isInteger(id)) continue; // ignore non-numeric dirs we didn't create
    const meeting = db.getMeeting(id);
    // Retained recordings survive restarts, including partial transcripts.
    // Explicitly deleted/merged meetings and confirmed empties are still swept.
    if (!meeting || (meeting.status === 'empty') || (!retainAudio && !KEEP_AUDIO_STATUSES.has(meeting.status))) {
      await remove(join(audioRoot, name), { recursive: true, force: true }).catch(() => {});
      result.sweptDirs += 1;
    }
  }
  if (result.sweptDirs > 0) log.log?.(`[reconcile] swept ${result.sweptDirs} orphaned audio dir(s).`);
  return result;
}

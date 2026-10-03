import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config/env.js';
import { writeMeetingExports } from './meeting-export.js';

// Called locally by the Windows helper through Docker. Only fixed application
// paths are returned; a URL cannot supply a filesystem path or shell command.
export async function prepareMeetingFiles(db, id, { dataDir = config.dataDir, exportDir = config.exportDir } = {}) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid meeting ID.');
  const meeting = db.getMeeting(id);
  if (!meeting) throw new Error('Meeting not found.');
  if (['recording', 'processing'].includes(meeting.status)) throw new Error('Wait until recording or processing finishes.');
  const exports = await writeMeetingExports(db, id, { directory: exportDir });
  const audio = join(dataDir, 'audio', String(id));
  let audioAvailable = false;
  try {
    audioAvailable = readdirSync(audio).some(name => name.endsWith('.pcm') && statSync(join(audio, name)).isFile());
  } catch { /* Older recordings may not have retained audio. */ }
  return { meetingId: id, exports, audio: audioAvailable ? audio : null };
}

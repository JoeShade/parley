// Export (or refresh) both archive files without transcription/summarisation.
// Usage: node scripts/export-meeting.mjs <meetingId>
import { join } from 'node:path';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { writeMeetingExports } from '../src/delivery/meeting-export.js';

const meetingId = Number(process.argv[2]);
if (!Number.isSafeInteger(meetingId) || meetingId < 1) {
  console.error('Usage: node scripts/export-meeting.mjs <meetingId>');
  process.exit(1);
}
const db = openDb(join(config.dataDir, 'meetings.db'));
try {
  const files = await writeMeetingExports(db, meetingId);
  console.log(`Markdown: ${files.markdown}\nJSON: ${files.json}`);
} catch (err) {
  console.error(`Export failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  db.sql.close();
}

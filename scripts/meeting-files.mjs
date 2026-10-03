// Machine-readable manifest for the Windows Explorer helper. Export copies use
// the current stored transcript; this never triggers a transcription job.
import { join } from 'node:path';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { prepareMeetingFiles } from '../src/delivery/meeting-files.js';

const db = openDb(join(config.dataDir, 'meetings.db'));
try {
  const files = await prepareMeetingFiles(db, Number(process.argv[2]));
  console.log('PARLEY_FILES=' + JSON.stringify(files));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally { db.sql.close(); }

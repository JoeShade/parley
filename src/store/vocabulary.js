// One global list shared by all servers. Each non-empty line is a literal term.
export function normalizeVocabulary(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 65536) {
    throw new Error('Upload a UTF-8 text file no larger than 64 KB.');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(text)) {
    throw new Error('Vocabulary must be valid UTF-8 text.');
  }
  return [...new Set(text.replace(/^\ufeff/, '').split(/\r?\n/).map(term => term.trim()).filter(Boolean))].join('\n');
}

export function getVocabulary(db) {
  return db.sql.prepare('SELECT value FROM app_settings WHERE key = ?').get('transcription_vocabulary')?.value || '';
}

export function setVocabulary(db, text) {
  const vocabulary = normalizeVocabulary(text);
  db.sql.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('transcription_vocabulary', vocabulary);
  return vocabulary;
}

import { transcribeTracks } from './transcribe.js';
import { buildTranscript, computeTalkTime } from './summarize.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { describeSummarizerError } from '../adapters/summarizer/errors.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { autoExportMeeting } from '../delivery/meeting-export.js';
import { getVocabulary } from '../store/vocabulary.js';

export async function processMeeting(db, meetingId, opts) {
  const meeting = db.getMeeting(meetingId);
  const transcribe = opts.transcribe || ((tracks, cfg) => transcribeTracks(tracks, cfg));

  db.setMeetingStatus(meetingId, 'processing');

  let utterances;
  let failures = [];
  const transcribeStart = Date.now();
  try {
    const result = await transcribe(opts.tracks, { ...opts.cfg, transcriptionVocabulary: getVocabulary(db) });
    // transcribeTracks returns { utterances, failures }, but opts.transcribe
    // is an injectable seam other callers/tests still use to return a bare
    // utterances array — accept both shapes.
    if (Array.isArray(result)) {
      utterances = result;
    } else {
      utterances = result.utterances;
      failures = result.failures || [];
    }
  } catch (err) {
    db.setTranscriptionComplete(meetingId, false);
    db.setMeetingStatus(meetingId, 'transcription_failed');
    err.userMessage = `Transcription failed — the STT sidecar may be down or unreachable. (${err.message})`;
    throw err;
  }
  const transcribeMs = Date.now() - transcribeStart;

  // A2: one or more tracks failing STT must not sink a meeting that
  // otherwise has usable transcript — only bail out when every track
  // failed and nothing came through.
  if (failures.length > 0) {
    console.warn(`[orchestrator] ${failures.length} track(s) failed transcription for meeting ${meetingId}`);
  }
  if (utterances.length === 0 && failures.length > 0) {
    db.setTranscriptionComplete(meetingId, false);
    db.setMeetingStatus(meetingId, 'transcription_failed');
    const err = new Error(`All ${failures.length} track(s) failed transcription`);
    err.userMessage = `Transcription failed — the STT sidecar may be down or unreachable. (${err.message})`;
    throw err;
  }
  try {
    db.replaceUtterances(meetingId, utterances, { complete: failures.length === 0 });
  } catch (err) {
    db.setMeetingStatus(meetingId, 'transcription_failed');
    err.userMessage = `Transcription could not be saved safely. (${err.message})`;
    throw err;
  }

  // Nobody actually spoke (bot joined an empty/near-silent channel). Don't
  // summarize or deliver — signal the caller to discard the meeting so these
  // empties never clutter the archive.
  if (utterances.length === 0) {
    db.setMeetingStatus(meetingId, 'empty');
    return { notes: null, talktime: [], empty: true };
  }

  if (opts.cfg.summarizerProvider === 'none') {
    const exported = await completeTranscriptMeeting(db, meetingId);
    return { notes: null, talktime: computeTalkTime(utterances), empty: false, transcriptOnly: true, ...exported };
  }

  const transcript = buildTranscript(utterances);
  const talktime = computeTalkTime(utterances);
  const attendees = db.listAttendees(meetingId).map((a) => a.display_name);
  const meta = {
    channelName: meeting.channel_name,
    date: meeting.started_at,
    attendees,
    summaryLanguage: resolveSummaryLanguage(opts.cfg),
  };

  let notes, summarizer;
  const summarizeStart = Date.now();
  try {
    summarizer = opts.summarizer || getSummarizer(opts.cfg);
    notes = await summarizer.summarize(transcript, meta);
  } catch (err) {
    db.setMeetingStatus(meetingId, 'summary_failed');
    // A failed summary must not stop the transcript archive.
    await autoExportMeeting(db, meetingId);
    // FallbackSummarizer already composed a message naming both attempts; don't
    // overwrite it with one that only mentions the primary provider.
    err.userMessage ??= describeSummarizerError(err, opts.cfg.summarizerProvider);
    throw err;
  }
  const summarizeMs = Date.now() - summarizeStart;

  const timings = { transcribeMs, summarizeMs, tracks: opts.tracks.length };
  console.log(`[pipeline] meeting ${meetingId}: transcribe ${transcribeMs}ms (${opts.tracks.length} tracks), summarize ${summarizeMs}ms`);

  // summarizer.lastUsed is set by FallbackSummarizer to whichever provider
  // actually produced these notes; plain adapters leave it undefined.
  const modelUsed = summarizer.lastUsed ?? `${opts.cfg.summarizerProvider}:${opts.cfg.summarizerModel || ''}`;
  db.saveSummary(meetingId, notes, talktime, modelUsed, new Date().toISOString(), timings);
  // Seed createdAt from the MEETING date, not now(): a pipeline that runs long
  // (long transcription queue) would otherwise stamp today onto a meeting that
  // started hours ago, so the action items collapse onto the wrong day in the
  // timeline view. (Mirrors what db.backfillTodos + realignTodoDates already do
  // for backfilled rows.)
  db.seedTodos(meetingId, meeting.guild_id, notes.actionItems || [], meeting.started_at);
  db.setMeetingStatus(meetingId, 'done', new Date().toISOString());
  const exportResult = await autoExportMeeting(db, meetingId);

  // Delivery is the last step and runs AFTER the summary is safely persisted, so
  // a posting failure (missing perms, deleted channel) must not throw away a
  // finished meeting or flip it back to a failed state — the notes already live
  // in the dashboard. Surface it via `delivered` + `deliveryError` so callers can
  // log it or offer a re-post, without treating the meeting as failed.
  let delivered = false;
  let deliveryError = null;
  if (opts.deliver) {
    try {
      await opts.deliver(notes, talktime, meta);
      delivered = true;
    } catch (err) {
      deliveryError = err.message || String(err);
      console.error(`[pipeline] meeting ${meetingId} summarized but delivery failed: ${deliveryError}`);
    }
  }
  return { notes, talktime, delivered, deliveryError, ...exportResult };
}

export async function completeTranscriptMeeting(db, meetingId) {
  db.clearSummary(meetingId);
  db.setMeetingStatus(meetingId, 'done', new Date().toISOString());
  return autoExportMeeting(db, meetingId);
}

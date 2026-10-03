import { readdir, stat, open, rename, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wavHeader } from '../voice/audio.js';

// Capture is mono, signed 16-bit PCM at 16 kHz. Mix by capture timestamps,
// preserving silence and overlapping speakers, without loading a match in RAM.
export async function writeMeetingWav(audioDir, destination) {
  async function existingWav() {
    try { return (await stat(destination)).isFile() ? destination : null; }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  let names;
  try { names = await readdir(audioDir); }
  catch (err) { if (err.code === 'ENOENT') return existingWav(); throw err; }
  const tracks = [];
  for (const name of names) {
    const match = /^(\d+)_(\d+)\.pcm$/.exec(name);
    if (!match) continue;
    const path = join(audioDir, name), info = await stat(path);
    const timestamp = Number(match[2]);
    if (!info.isFile() || info.size < 2 || !Number.isSafeInteger(timestamp)) continue;
    if (info.size % 2) throw new Error(`Incomplete PCM sample in ${name}.`);
    tracks.push({ path, timestamp, samples: info.size / 2 });
  }
  if (!tracks.length) return existingWav();
  tracks.sort((a, b) => a.timestamp - b.timestamp);
  const origin = tracks[0].timestamp;
  for (const track of tracks) {
    track.start = (track.timestamp - origin) * 16;
    track.end = track.start + track.samples;
  }
  const samples = tracks.reduce((end, track) => Math.max(end, track.end), 0);
  if (!Number.isSafeInteger(samples) || samples * 2 > 0xffffffff - 36) {
    throw new Error('Recording is too long for a standard WAV file.');
  }
  const temporary = `${destination}.${randomUUID()}.tmp`, active = new Map();
  let out, next = 0;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    out = await open(temporary, 'wx', 0o600);
    await out.writeFile(wavHeader(samples * 2));
    const blockSize = 16000;
    for (let position = 0; position < samples; position += blockSize) {
      const count = Math.min(blockSize, samples - position), end = position + count;
      while (next < tracks.length && tracks[next].start < end) {
        const track = tracks[next++];
        active.set(track, await open(track.path, 'r'));
      }
      const mixed = new Int32Array(count);
      for (const [track, file] of active) {
        const start = Math.max(position, track.start), stop = Math.min(end, track.end);
        if (stop > start) {
          const bytes = Buffer.alloc((stop - start) * 2);
          let read = 0;
          while (read < bytes.length) {
            const result = await file.read(bytes, read, bytes.length - read, (start - track.start) * 2 + read);
            if (!result.bytesRead) throw new Error('Recording changed while exporting WAV.');
            read += result.bytesRead;
          }
          for (let i = 0; i < bytes.length / 2; i++) mixed[start - position + i] += bytes.readInt16LE(i * 2);
        }
        if (track.end <= end) { await file.close(); active.delete(track); }
      }
      const bytes = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.max(-32768, Math.min(32767, mixed[i])), i * 2);
      await out.writeFile(bytes);
    }
    await out.close(); out = null;
    await rename(temporary, destination);
    return destination;
  } finally {
    await out?.close();
    await Promise.all([...active.values()].map(file => file.close()));
    await rm(temporary, { force: true });
  }
}

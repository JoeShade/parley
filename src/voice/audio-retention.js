import { rm } from 'node:fs/promises';
import { config } from '../config/env.js';

// Shared by live completion and retries. Failed pipelines never call this.
export async function cleanupProcessedAudio(audioDir, { empty = false, retainAudio = config.retainAudio } = {}) {
  if (retainAudio && !empty) return;
  await rm(audioDir, { recursive: true, force: true }).catch(() => {});
}

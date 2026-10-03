import { readFile as fsReadFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from '../config/env.js';

export async function transcribeFile(filePath, opts = {}, deps = {}) {
  const baseUrl = deps.baseUrl || config.sttUrl;
  const fetchImpl = deps.fetchImpl || fetch;
  const readFile = deps.readFile || fsReadFile;
  const retries = deps.retries ?? 1;
  // Generous: one call transcribes a whole speaking turn, which on CPU can take
  // minutes for the larger models. This only fires on a stalled (silent) sidecar;
  // a dead one fails fast with ECONNREFUSED. Tunable via deps.timeoutMs.
  const timeoutMs = deps.timeoutMs ?? 600_000;

  const bytes = await readFile(filePath);
  const backoffMs = deps.backoffMs ?? 500;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([bytes]), basename(filePath));
      form.append('model', opts.model || 'small');
      form.append('language', opts.language || 'auto');
      if (opts.vocabulary) form.append('vocabulary', opts.vocabulary);
      const res = await fetchImpl(`${baseUrl}/transcribe`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // 4xx is a client error (bad request/model/payload) — retrying re-uploads
        // the whole file to fail again. Only retry 5xx / network errors.
        const err = new Error(`STT sidecar HTTP ${res.status}`);
        err.status = res.status;
        if (res.status >= 400 && res.status < 500) throw Object.assign(err, { noRetry: true });
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err?.noRetry) break; // don't burn retries on a permanent client error
      // Back off before retrying a transient failure (stalled/booting sidecar).
      if (attempt < retries && backoffMs > 0) {
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

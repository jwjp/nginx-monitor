import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

// The contract requires a timeout and does not name a configuration variable.
export const NGINX_TEST_TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 300;

export function parsePid(text) {
  if (typeof text !== 'string') return { ok: false };
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const pid = Number(trimmed);
  if (!Number.isSafeInteger(pid)) return { ok: false };
  return { ok: true, pid };
}

export async function readPidFile(file, readFileImpl = readFile) {
  try {
    const text = await readFileImpl(file, 'utf8');
    return parsePid(text);
  } catch {
    return { ok: false };
  }
}

function stderrText(error) {
  if (typeof error?.stderr === 'string') return error.stderr;
  if (Buffer.isBuffer(error?.stderr)) return error.stderr.toString('utf8');
  return '';
}

export async function runNginxTest(bin, {
  timeoutMs = NGINX_TEST_TIMEOUT_MS,
  execFileImpl = execFileAsync,
} = {}) {
  try {
    await execFileImpl(bin, ['-t'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return { ok: true };
  } catch (error) {
    const stderr = stderrText(error).trim().slice(0, STDERR_LIMIT);
    return { ok: false, stderr };
  }
}

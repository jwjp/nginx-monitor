import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { withSnapshot, writeHistory } from '../src/history.js';

test('keeps the newest snapshots up to the limit', () => {
  const first = withSnapshot([], { timestamp: 'a' }, 2);
  const second = withSnapshot(first, { timestamp: 'b' }, 2);
  const third = withSnapshot(second, { timestamp: 'c' }, 2);
  assert.deepEqual(third.map((item) => item.timestamp), ['c', 'b']);
});

test('replaces the history file from a temporary file in the same directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nginx-monitor-'));
  const file = path.join(dir, 'status-history.json');
  try {
    await writeHistory(file, { timestamp: 'old', statuses: [] }, 2);
    await writeHistory(file, { timestamp: 'new', statuses: [], probe: { ok: false, status: 500 } }, 2);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(stored.map((item) => item.timestamp), ['new', 'old']);
    const names = await readdir(dir);
    assert.deepEqual(names, ['status-history.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

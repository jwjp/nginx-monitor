import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePid, readPidFile, runNginxTest } from '../src/nginx-cmd.js';

test('reads a single pid and rejects other file contents', async () => {
  assert.deepEqual(parsePid('42\n'), { ok: true, pid: 42 });
  assert.equal(parsePid('42 43').ok, false);
  assert.equal(parsePid('nope').ok, false);

  const dir = await mkdtemp(path.join(tmpdir(), 'nginx-monitor-pid-'));
  const file = path.join(dir, 'nginx.pid');
  try {
    await writeFile(file, '99\n');
    assert.deepEqual(await readPidFile(file), { ok: true, pid: 99 });
    assert.equal((await readPidFile(path.join(dir, 'missing.pid'))).ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runs nginx -t with an argument array and trims stderr on failure', async () => {
  const ok = await runNginxTest('nginx', {
    execFileImpl: async (bin, args) => {
      assert.equal(bin, 'nginx');
      assert.deepEqual(args, ['-t']);
      return { stdout: '', stderr: 'nginx: the configuration file syntax is ok' };
    },
  });
  assert.deepEqual(ok, { ok: true });

  const failed = await runNginxTest('nginx', {
    execFileImpl: async () => {
      const error = new Error('failed');
      error.stderr = `bad directive\n${'x'.repeat(400)}`;
      throw error;
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.stderr.length, 300);
  assert.equal(failed.stderr.startsWith('bad directive'), true);
});

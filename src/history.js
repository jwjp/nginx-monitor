import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function withSnapshot(history, snapshot, maxHistory) {
  return [snapshot, ...history].slice(0, maxHistory);
}

export async function readHistoryFile(file, readFileImpl = readFile) {
  try {
    const text = await readFileImpl(file, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function replaceFile(tmp, dest, fs) {
  try {
    await fs.rename(tmp, dest);
  } catch (error) {
    // Windows rename cannot replace an existing file. Linux is the supported host.
    if (error.code === 'EEXIST' || error.code === 'EPERM') {
      await fs.unlink(dest).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      await fs.rename(tmp, dest);
      return;
    }
    throw error;
  }
}

export async function writeHistory(file, snapshot, maxHistory, fs = {
  readFile,
  writeFile,
  rename,
  unlink,
}) {
  let history = [];
  try {
    history = await readHistoryFile(file, fs.readFile);
  } catch (error) {
    if (error.name !== 'SyntaxError') throw error;
    console.error('status history is unreadable');
    history = [];
  }

  const next = withSnapshot(history, snapshot, maxHistory);
  const tmp = path.join(
    path.dirname(file),
    `${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  try {
    await replaceFile(tmp, file, fs);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

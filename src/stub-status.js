export const BODY_CAP = 64 * 1024;

const ACTIVE_LINE = /^Active connections: ?(\d+)$/;
const COUNTER_LINE = /^(\d+) (\d+) (\d+)$/;
const ACTIVITY_LINE = /^Reading: ?(\d+) Writing: ?(\d+) Waiting: ?(\d+)$/;

function parseCount(raw) {
  if (!/^\d+$/.test(raw)) return null;
  let asBig;
  try {
    asBig = BigInt(raw);
  } catch {
    return null;
  }
  const value = Number(asBig);
  if (!Number.isSafeInteger(value) || BigInt(value) !== asBig) return null;
  return value;
}

export function parseStubStatus(body) {
  if (typeof body !== 'string') return { ok: false, reason: 'bad_status_page' };
  const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const content = lines
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '');
  if (content.length !== 4) return { ok: false, reason: 'bad_status_page' };
  if (content[1] !== 'server accepts handled requests') {
    return { ok: false, reason: 'bad_status_page' };
  }

  const active = ACTIVE_LINE.exec(content[0]);
  const counters = COUNTER_LINE.exec(content[2]);
  const activity = ACTIVITY_LINE.exec(content[3]);
  if (!active || !counters || !activity) return { ok: false, reason: 'bad_status_page' };

  const parsed = [active[1], counters[1], counters[2], counters[3], activity[1], activity[2], activity[3]]
    .map(parseCount);
  if (parsed.some((value) => value === null)) return { ok: false, reason: 'bad_status_page' };

  return {
    ok: true,
    sample: {
      active: parsed[0],
      accepts: parsed[1],
      handled: parsed[2],
      requests: parsed[3],
      reading: parsed[4],
      writing: parsed[5],
      waiting: parsed[6],
    },
  };
}

export function diffSamples(previous, current) {
  const accepts = current.accepts - previous.accepts;
  const handled = current.handled - previous.handled;
  const requests = current.requests - previous.requests;
  if (accepts < 0 || handled < 0 || requests < 0) {
    return { restart: true };
  }
  return {
    restart: false,
    accepts,
    handled,
    requests,
    dropped: accepts - handled,
  };
}

export function elapsedSeconds(previousAt, at) {
  if (typeof previousAt !== 'number' || typeof at !== 'number') return 0;
  const delta = at - previousAt;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.round(delta / 1000);
}

async function readCapped(response, cap) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    return { oversize: true };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (Buffer.byteLength(text) > cap) return { oversize: true };
    return { text };
  }

  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return { oversize: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

function classify(text) {
  const parsed = parseStubStatus(text);
  if (!parsed.ok) return { type: 'bad_status_page' };
  return { type: 'ok', sample: parsed.sample };
}

export async function fetchStubStatus(url, { timeoutMs, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { type: 'down' };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { type: 'down' };
    }
    const body = await readCapped(response, BODY_CAP);
    if (body.oversize) return { type: 'down' };
    return classify(body.text);
  } catch {
    return { type: 'down' };
  } finally {
    clearTimeout(timer);
  }
}

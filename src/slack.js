// Slack reads <, > and & as control syntax, so `nginx -t` stderr that echoes
// config text could otherwise post a link or a <!channel> mention.
export function escapeSlack(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatAlert({ target, kind, at, reason, recovery }, deliveredAt = at) {
  const stamp = new Date(at).toISOString();
  const label = recovery ? `${kind} recovered` : kind;
  const late = deliveredAt !== at ? `\ndelivered late at ${new Date(deliveredAt).toISOString()}` : '';
  return `[nginx] ${escapeSlack(target)} ${label}\n${stamp}\n${escapeSlack(reason)}${late}`;
}

export function gateAlert(sent, event, now, durationMs) {
  const key = `${event.target}::${event.kind}`;
  if (event.release) {
    if (sent[key] === undefined) return { send: false, sent };
    const next = { ...sent };
    delete next[key];
    return { send: false, sent: next };
  }
  if (event.recovery) {
    const next = { ...sent };
    delete next[key];
    return { send: true, sent: next };
  }
  // A restart is an event, not a condition that stays true, so each one sends.
  if (event.kind === 'restart') return { send: true, sent };
  const last = sent[key];
  if (last !== undefined && (event.once === true || now - last < durationMs)) {
    return { send: false, sent };
  }
  return { send: true, sent: { ...sent, [key]: now } };
}

export const MAX_QUEUED_RESTARTS = 10;

// Each restart is its own event, so a queued restart is never replaced by a
// later one. Every other kind keeps one queued copy per target and kind.
export function queueKey(event) {
  const key = `${event.target}::${event.kind}`;
  return event.kind === 'restart' ? `${key}::${event.at}` : key;
}

// Keeps the newest restarts for a target when Slack stays unreachable.
export function queueUndelivered(undelivered, event) {
  const next = { ...undelivered, [queueKey(event)]: event };
  if (event.kind !== 'restart') return next;
  const restarts = Object.entries(next)
    .filter(([, queued]) => queued.kind === 'restart' && queued.target === event.target)
    .sort(([, a], [, b]) => a.at - b.at);
  for (const [key] of restarts.slice(0, Math.max(0, restarts.length - MAX_QUEUED_RESTARTS))) {
    delete next[key];
  }
  return next;
}

// A failed post stays queued because the next cycle will not build that event
// again. A newer incident for the same target and kind replaces the queued
// copy. Every queued event is older than this cycle, so the whole backlog goes
// first, oldest first, which also puts an incident ahead of its recovery.
export function orderDeliveries(events, undelivered = {}) {
  const pending = undelivered ?? {};
  const replaced = new Set();
  for (const event of events) {
    if (!event.release && !event.recovery) replaced.add(queueKey(event));
  }
  const backlog = Object.entries(pending)
    .filter(([key]) => !replaced.has(key))
    .map(([, event]) => event)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return [...backlog, ...events];
}

export async function sendSlack(webhookUrl, text, { timeoutMs, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    await response.body?.cancel();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`slack status ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

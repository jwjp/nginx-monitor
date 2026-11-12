export function parseAcceptedStatuses(value) {
  const parts = String(value).split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('PROBE_ACCEPTED_STATUSES is empty.');
  }

  const ranges = [];
  for (const part of parts) {
    const range = /^(\d{3})-(\d{3})$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) {
        throw new Error('PROBE_ACCEPTED_STATUSES has a descending range.');
      }
      ranges.push([start, end]);
      continue;
    }
    if (!/^\d{3}$/.test(part)) {
      throw new Error('PROBE_ACCEPTED_STATUSES must be a status, a list, or a range.');
    }
    const code = Number(part);
    ranges.push([code, code]);
  }
  return ranges;
}

export function statusAccepted(status, ranges) {
  return ranges.some(([start, end]) => status >= start && status <= end);
}

export function stripUserinfo(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return value;
  }
}

async function fetchWithTimeout(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProbe(url, { timeoutMs, ranges, fetchImpl = globalThis.fetch }) {
  try {
    const response = await fetchWithTimeout(url, timeoutMs, fetchImpl);
    const status = response.status;
    await response.body?.cancel();
    if (status >= 300 && status < 400) {
      return { ok: false, status };
    }
    if (!statusAccepted(status, ranges)) {
      return { ok: false, status };
    }
    return { ok: true, status };
  } catch {
    return { ok: false, status: null };
  }
}

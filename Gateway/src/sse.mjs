function streamError(code) {
  const error = new Error('Upstream event stream is invalid.');
  error.code = code;
  error.status = 502;
  error.details = { safeToRetry: false, outcome: 'unknown' };
  return error;
}

function aborted(signal) {
  const error = new Error('Stream consumption was cancelled.');
  error.name = 'AbortError';
  error.code = 'stream_cancelled';
  return error;
}

export function withSignal(promise, signal) {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  if (signal.aborted) {
    // The caller has already started the operation. Handle any later
    // rejection so cancellation does not leave it unhandled.
    pending.catch(() => {});
    return Promise.reject(aborted(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(aborted(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function* chunks(readable, signal) {
  if (!readable) throw streamError('upstream_missing_stream');
  if (typeof readable.getReader === 'function') {
    const reader = readable.getReader();
    let done = false;
    try {
      while (true) {
        const next = await withSignal(reader.read(), signal);
        if (next.done) { done = true; return; }
        yield next.value;
      }
    } finally {
      if (!done) reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return;
  }
  if (typeof readable[Symbol.asyncIterator] !== 'function') throw streamError('upstream_missing_stream');
  const iterator = readable[Symbol.asyncIterator]();
  let done = false;
  try {
    while (true) {
      const next = await withSignal(iterator.next(), signal);
      if (next.done) { done = true; return; }
      yield next.value;
    }
  } finally {
    if (!done && iterator.return) Promise.resolve(iterator.return()).catch(() => {});
  }
}

export async function* parseSSE(readable, { maxEventBytes = 2000000, signal } = {}) {
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) throw new TypeError('Invalid event size limit.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let eventBytes = 0;
  let event = '';
  let id = '';
  let data = [];
  function line(text, delimiterBytes = 0) {
    eventBytes += Buffer.byteLength(text, 'utf8') + delimiterBytes;
    if (eventBytes > maxEventBytes) throw streamError('upstream_event_too_large');
    if (text === '') {
      const result = data.length ? { event, id, data: data.join('\n') } : null;
      event = '';
      data = [];
      eventBytes = 0;
      return result;
    }
    if (text.startsWith(':')) return null;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    return null;
  }
  function* drain(final) {
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const char = pending[i];
      if (char !== '\n' && char !== '\r') continue;
      if (char === '\r' && i === pending.length - 1 && !final) break;
      const crlf = char === '\r' && pending[i + 1] === '\n';
      const result = line(pending.slice(start, i), crlf ? 2 : 1);
      if (crlf) i++;
      start = i + 1;
      if (result) yield result;
    }
    pending = pending.slice(start);
    if (eventBytes + Buffer.byteLength(pending, 'utf8') > maxEventBytes) throw streamError('upstream_event_too_large');
    if (final && pending !== '') {
      const result = line(pending);
      pending = '';
      if (result) yield result;
    }
  }
  try {
    for await (const chunk of chunks(readable, signal)) {
      if (!(chunk instanceof Uint8Array)) throw streamError('upstream_invalid_stream_chunk');
      pending += decoder.decode(chunk, { stream: true });
      yield* drain(false);
    }
    pending += decoder.decode();
    yield* drain(true);
    // Accept a final complete SSE data field without a trailing blank line.
    // Transport still requires an explicit Responses terminal event.
    if (data.length) yield { event, id, data: data.join('\n') };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code?.startsWith('upstream_')) throw error;
    if (error instanceof TypeError) throw streamError('upstream_invalid_utf8');
    throw streamError('upstream_stream_read_error');
  }
}

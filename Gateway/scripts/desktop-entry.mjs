import { createInterface } from 'node:readline';
import { Desktop } from './desktop.mjs';

const [directory, proxyBinary] = process.argv.slice(2);
if (!directory || !proxyBinary) process.exit(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const desktop = new Desktop({ directory, proxyBinary, send });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closing = false;
const ready = desktop.initialize().then(() => true).catch(error => {
  const code = /^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'desktop_start_failed';
  send({ state: 'error', code, fatal: true });
  setImmediate(() => void close());
  return false;
});
async function close() {
  if (closing) return;
  closing = true;
  // Abort pending authorization and gracefully shut down both service processes.
  await ready;
  await desktop.close().catch(() => { process.exitCode = 1; });
  input.close();
  process.stdin.destroy();
}
input.on('line', line => {
  if (!closing) void ready.then(initialized => initialized && !closing && desktop.enqueue(() => desktop.command(line)));
});
input.on('close', () => void close());
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
process.stdout.on('error', () => void close());

import { runStack } from './run-stack.mjs';

// The desktop supervisor holds the write end for the stack's entire lifetime.
process.stdin.resume();
const stop = () => process.kill(process.pid, 'SIGTERM');
process.stdin.once('end', stop);
process.stdin.once('error', stop);
try {
  await runStack();
} catch (error) {
  const code = /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'stack_setup_failed';
  console.log(JSON.stringify({ event: 'stack_error', code }));
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
}

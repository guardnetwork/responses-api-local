#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The parent owns stdin's write end. Its crash closes the pipe so this child
// can stop safely instead of becoming an orphan that holds the service ports.
const role = process.argv[2];
process.stdin.resume();
if (role === 'gateway') {
  let ready = false, parentGone = false;
  const detach = () => { process.stdin.pause(); process.stdin.destroy(); };
  const parentLost = () => { parentGone = true; if (ready) process.kill(process.pid, 'SIGTERM'); };
  process.stdin.once('end', parentLost); process.stdin.once('error', parentLost);
  process.on('SIGTERM', detach); process.on('SIGINT', detach);
  await import(pathToFileURL(resolve(import.meta.dirname, '../src/main.mjs')).href);
  ready = true;
  if (parentGone) process.kill(process.pid, 'SIGTERM');
} else if (role === 'proxy') {
  const binary = process.argv[3], config = process.argv[4];
  if (!binary || !config) process.exit(1);
  const proxy = spawn(binary, ['-config', config], { stdio: 'ignore', env: process.env });
  let timer, stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    process.stdin.pause(); process.stdin.destroy();
    if (proxy.exitCode === null && proxy.signalCode === null) {
      proxy.kill('SIGTERM');
      timer = setTimeout(() => proxy.kill('SIGKILL'), 6000);
    }
  };
  process.stdin.once('end', stop); process.stdin.once('error', stop);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  proxy.once('error', () => { process.exitCode = 1; process.stdin.destroy(); });
  proxy.once('exit', (code, signal) => { clearTimeout(timer); process.stdin.destroy(); process.exitCode = stopping ? 0 : (code || (signal ? 1 : 0)); });
} else {
  process.stdin.destroy(); process.exitCode = 1;
}

#!/usr/bin/env node
// Fake "sing-box" stub for EngineProcess unit tests (spec §6.3). Never a real
// binary: it just reads the piped config off stdin, optionally parses a JSON
// test-control spec out of it, and behaves accordingly — echoing scripted
// log lines to stderr (matching real sing-box's own stderr logging) and
// staying alive until signalled, exactly like the real process does.
//
// Recognised fields (all optional) when stdin JSON-parses:
//   __fakeLogLines      string[]  — lines written to stderr, one per line
//   __fakeExitCode      number    — exit with this code right after logging (simulates a crash)
//   __fakeIgnoreSignals boolean   — swallow SIGINT/SIGTERM (forces the supervisor's hard-kill fallback)
//
// If stdin isn't valid JSON (e.g. a real rendered config), it just logs a
// generic "started" line and stays alive, same as the real binary would.

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  let spec = {};
  try {
    spec = JSON.parse(input);
  } catch {
    spec = {};
  }

  if (spec.__fakeIgnoreSignals) {
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  }

  const logLines =
    Array.isArray(spec.__fakeLogLines) && spec.__fakeLogLines.length > 0
      ? spec.__fakeLogLines
      : ['INFO[0000] fake sing-box started'];
  for (const line of logLines) {
    process.stderr.write(`${line}\n`);
  }

  if (typeof spec.__fakeExitCode === 'number') {
    process.exitCode = spec.__fakeExitCode;
    process.exit(spec.__fakeExitCode);
  }
});

// Keep the event loop alive like a real long-running sing-box process.
setInterval(() => {}, 1 << 30);

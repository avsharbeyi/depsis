// A minimal two-socket agent client, for probes.
//
// Deliberately dependency-free and deliberately NOT the production client: this exists so a shell
// probe can drive both halves of the wire and compare what comes back with what the units and the
// Rust claim. `apps/api` has the real one, with budgets and a version handshake.
//
// Usage:
//   node agent-client.mjs control '<envelope json>'
//   node agent-client.mjs data     <token> <offset> <payload>   # preamble, then the body
//   node agent-client.mjs data1    <token> <offset> <payload>   # both in ONE write
//
// The `data1` mode is the interesting one. A client that writes the preamble and its first payload
// bytes in a single syscall is the ordinary case — `stream.pipeline(body, socket)` does it, and
// packet coalescing does it anyway — and it is the case that breaks if the agent's preamble reader
// discards whatever followed the newline. Having both modes here means the probe can show the two
// are byte-identical on disk rather than assuming it.

import net from 'node:net';

const CONTROL = '/run/depsis/agent.sock';
const DATA = '/run/depsis/agent-data.sock';
const LINE_TIMEOUT_MS = 10_000;

const [, , mode, ...rest] = process.argv;
const path = mode === 'control' ? CONTROL : DATA;

const socket = net.connect(path);
let buffered = Buffer.alloc(0);
const ready = [];
const waiting = [];

socket.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (let at = buffered.indexOf(0x0a); at !== -1; at = buffered.indexOf(0x0a)) {
    const line = buffered.subarray(0, at).toString('utf8');
    buffered = buffered.subarray(at + 1);
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(line);
    else ready.push(line);
  }
});

function nextLine() {
  if (ready.length > 0) return Promise.resolve(ready.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for a reply line')),
      LINE_TIMEOUT_MS,
    );
    waiting.push({
      resolve: (line) => {
        clearTimeout(timer);
        resolve(line);
      },
    });
  });
}

try {
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  if (mode === 'control') {
    // `write`, not `end`. The agent's reader breaks on the newline, so a half-close is not needed
    // to frame the request — and it is what makes the reply race on some transports.
    socket.write(`${rest[0]}\n`);
    console.log(await nextLine());
  } else {
    const [token, offset, payload] = rest;
    const body = Buffer.from(payload, 'utf8');
    const preamble = `${JSON.stringify({ token, offset: Number(offset), length: body.length })}\n`;

    if (mode === 'data1') {
      socket.write(Buffer.concat([Buffer.from(preamble, 'utf8'), body]));
      console.log(await nextLine()); // ready
      console.log(await nextLine()); // stored / failed
    } else {
      socket.write(preamble);
      const first = await nextLine();
      console.log(first);
      if (JSON.parse(first).status === 'ready') {
        socket.write(body);
        console.log(await nextLine());
      }
    }
  }
  socket.destroy();
} catch (error) {
  console.error(String(error?.message ?? error));
  socket.destroy();
  process.exitCode = 1;
}

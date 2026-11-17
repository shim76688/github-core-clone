// main.ts — process bootstrap for the forge.
//
// The harness starts this program beside a companion service (the "env")
// and the two talk over HTTP. Everything in this file is that handshake:
//
//   * Where the env lives arrives in the MAKEFUN_ENV_URL variable. When
//     the variable is missing there is nobody to handshake with, so the
//     process gives up immediately with exit code 1.
//   * The forge server built by app.ts is started on port 0, letting the
//     operating system pick a free port; a fixed port is never bound,
//     because the env already owns its own.
//   * The chosen port is announced to the env with POST /register and a
//     JSON body of {"port": n}. From then on the env dials that port
//     whenever the suite wants the forge.
//   * GET /done is polled until its JSON answer carries done: true. The
//     env answers right away either way, so polling — never a held-open
//     request — is the correct shape, and this process must not exit
//     before the answer flips.
//   * When the trial is over the server is closed and the process exits
//     0, which is the harness's cue to stop the env and score its export.
//
// Each env request runs under a hard deadline and failures are retried
// with a growing pause, since the env may still be booting when this
// process starts. Nothing here imports a package or a Node built-in: the
// server arrives from ./app.ts and the rest is language globals.

import { createApp as buildForgeServer } from './app.ts';

const ENV_URL_VARIABLE = 'MAKEFUN_ENV_URL';
const REQUEST_DEADLINE_MS = 30_000;
const SHORTEST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charAt(end - 1) === '/') {
    end -= 1;
  }
  return url.slice(0, end);
}

// A stateful backoff for one retry loop: the pauses it hands out run
// 250ms, 500ms, 1s, and then sit at the 2s ceiling.
function newBackoff(): () => Promise<void> {
  let upcoming = SHORTEST_PAUSE_MS;
  return async () => {
    await pause(upcoming);
    upcoming = Math.min(LONGEST_PAUSE_MS, upcoming * 2);
  };
}

// One env request under the shared deadline. It resolves with the
// response, or with null when the request itself failed — a refused
// connection, a blown deadline — which callers read as "not ready yet".
async function envRequest(envBase: string, path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(envBase + path, { ...init, signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) });
  } catch {
    return null;
  }
}

// Announce the bound port to the env and keep announcing until it sticks.
// A 200 means the env recorded us; a 409 means an earlier announcement
// already won and ours changes nothing — both end the loop. A 400 or 405
// says the request itself breaks the contract, which is fatal, and the
// response body carries the reason. Anything else (a refused connection,
// a 5xx while the env boots, a blown deadline) is worth retrying.
async function announcePort(envBase: string, port: number): Promise<void> {
  const wait = newBackoff();
  for (;;) {
    const response = await envRequest(envBase, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: port }),
    });
    if (response === null) {
      await wait();
      continue;
    }
    if (response.status === 200 || response.status === 409) {
      return;
    }
    if (response.status === 400 || response.status === 405) {
      const detail = await response.text().catch(() => '');
      throw new Error('the env refused registration (HTTP ' + response.status + '): ' + detail);
    }
    // Any other status is retryable; drain the body first so the
    // connection underneath can be reused by the next attempt.
    await response.arrayBuffer().catch(() => undefined);
    await wait();
  }
}

// Poll the env's /done endpoint until it reports the trial has ended.
async function waitForTrialEnd(envBase: string): Promise<void> {
  const wait = newBackoff();
  for (;;) {
    const response = await envRequest(envBase, '/done');
    if (response !== null && response.ok) {
      let finished = false;
      try {
        const payload: unknown = await response.json();
        finished =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      } catch {
        // An unparseable answer means "not done", like any other failure.
      }
      if (finished) {
        return;
      }
    }
    await wait();
  }
}

async function run(): Promise<void> {
  const envBase = withoutTrailingSlashes(process.env[ENV_URL_VARIABLE] ?? '');
  if (envBase.length === 0) {
    process.stderr.write('[forge-entry] ' + ENV_URL_VARIABLE + ' is not set; there is no env to register with\n');
    process.exit(1);
  }

  const server = buildForgeServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, () => {
      resolveListen();
    });
  });

  const boundAddress = server.address();
  if (boundAddress === null || typeof boundAddress === 'string') {
    throw new Error('the forge server did not bind a TCP port');
  }
  process.stdout.write('[forge-entry] listening on port ' + boundAddress.port + '\n');

  await announcePort(envBase, boundAddress.port);
  process.stdout.write('[forge-entry] registered with the env; waiting for the trial to end\n');

  await waitForTrialEnd(envBase);
  server.close();
  process.stdout.write('[forge-entry] the env reports done; exiting\n');
}

run().then(
  () => {
    process.exit(0);
  },
  (failure: unknown) => {
    const message = failure instanceof Error ? failure.message : String(failure);
    process.stderr.write('[forge-entry] ' + message + '\n');
    process.exit(1);
  },
);

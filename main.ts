// Forge lifecycle: bring the server up on a kernel-chosen port, hand that port to the
// trial environment, then stay alive until the environment reports the trial is over.
//
// The environment (env) is the suite that grades this forge. It listens on 8080 and
// expects this process to:
//   - read its origin from MAKEFUN_ENV_URL (no value means there is no suite: exit 1)
//   - start the forge app on port 0 and learn the port the kernel assigned
//   - POST the port to <env>/register so the suite can dial the forge
//   - poll <env>/done until it answers {"done": true}, then shut down cleanly (exit 0)
//
// This file only drives that handshake. All serving lives in app.ts.

import { createApp } from "./app.ts";

// Origin of the trial environment, with any trailing slashes removed.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin === "") {
  process.stderr.write("[forge] MAKEFUN_ENV_URL is missing, so there is no environment to join\n");
  process.exit(1);
}

// One HTTP attempt may take this long before it is given up on and retried.
const REQUEST_LIMIT_MS = 30_000;
// Retry spacing starts here and doubles, but never passes the cap below.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// How long to wait before the next attempt after `failures` failed attempts.
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

// Marker for the contract errors `announce` throws, so the catch below can tell them
// apart from the network errors it must retry instead.
const REGISTER_ERROR_PREFIX = "register replied HTTP ";

// Tell the environment which port the forge bound. A 200 means it heard us; a 409 means
// another process already registered first, which is fine — we just wait like everyone
// else. A 400 or 405 is a contract violation and ends the run; anything else (a network
// failure, another status, the environment still booting) is retried.
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`${REGISTER_ERROR_PREFIX}${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(REGISTER_ERROR_PREFIX)) throw error;
    }
    await pause(backoffMs(failures));
  }
}

// Ask the environment whether the trial has finished, polling until it says yes.
// A failed poll (the environment is not answering yet, or the request timed out) just
// means "not done", so it is retried the same way.
async function awaitDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_LIMIT_MS) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Not answering yet — treat as not done and poll again.
    }
    await pause(backoffMs(failures));
  }
}

// Start the forge, register its port, wait for the trial to end, then shut down.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[forge] listening on ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write("[forge] registered with the environment, waiting for done\n");

  await awaitDone();
  server.close();
  process.stdout.write("[forge] done\n");
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

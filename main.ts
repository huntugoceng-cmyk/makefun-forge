// The entry <-> env lifecycle: bind an ephemeral port, register it, poll until the
// env says the trial is over, then exit 0.
import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function register(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 201) return true;
      if (res.status === 409) return true;
    } catch {
      // retried below
    }
    await sleep(Math.min(2_000, 250 * 2 ** Math.min(attempt, 8)));
  }
  return false;
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      const body = (await res.json()) as { done?: boolean };
      if (body.done === true) return;
    } catch {
      // retried below
    }
    await sleep(200);
  }
}

const { server } = createApp();

server.listen(0, '0.0.0.0', async () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await register(port);
  await waitForDone();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
});

// app/api/cassette/route.ts — a test-only control-plane endpoint.
//
// Playwright POSTs `{ "name": "<cassette>" }` here before each test to switch the
// active cassette. `createBobina(bobinaConfig)` returns the SAME singleton that
// `instrumentation.ts` created at startup (state lives on globalThis, so it
// survives Next's server bundle splitting — PLAN gotcha #4). We are not starting
// a second engine; we are steering the one already listening.

import { createBobina } from 'bobina';

// Relative import so the recipe works with no path-alias config; in a real app
// this is typically `@/lib/bobina-e2e` (the create-next-app default alias).
import { bobinaConfig } from '../../../lib/bobina-e2e';

export async function POST(request: Request) {
  // Never let this be reachable in a real deployment.
  if (!process.env.E2E_MODE) {
    return new Response('Not found', { status: 404 });
  }

  const { name } = (await request.json()) as { name: string };

  // Same cassetteDir/mode/hosts → reuses the existing singleton engine.
  await createBobina(bobinaConfig).useCassette(name);

  return Response.json({ ok: true, cassette: name });
}

// instrumentation.ts — lives at the project root (next to next.config.js).
//
// Next.js calls `register()` exactly once per server runtime at startup. This is
// the seam where bobina attaches its interceptor before any route handler runs,
// so the first outbound `fetch` to Anthropic/OpenRouter is already observed.

export async function register() {
  // Gate on E2E_MODE: in normal dev/prod it is unset, so bobina (and
  // @mswjs/interceptors) is never even imported into the server graph.
  if (!process.env.E2E_MODE) return;

  // Only the Node.js runtime — never Edge, where node:* and the interceptor
  // primitives don't exist. `register()` also runs in the Edge runtime.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Dynamic import keeps bobina out of the Edge bundle and out of the normal
  // (non-E2E) server module graph entirely.
  const { createBobina } = await import('bobina');
  // Relative import here so the recipe works with no path-alias config. In a real
  // app you'd likely write `@/lib/bobina-e2e` (the create-next-app default alias).
  const { bobinaConfig } = await import('./lib/bobina-e2e');

  // createBobina stashes the engine on globalThis; the cassette route below
  // reuses this exact instance. `.listen()` activates the interceptor.
  await createBobina(bobinaConfig).listen();
}

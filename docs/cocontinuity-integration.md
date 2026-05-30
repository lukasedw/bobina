# Adopting bobina in cocontinuity (follow-up)

> **Not part of the bobina build-out.** This is the checklist for the manual swap
> done **later, in the cocontinuity repo**, once bobina is published. Tracked
> here so the steps aren't lost; nothing in this document runs during bobina's
> own execution.

cocontinuity currently has a hand-rolled VCR in `lib/testing/e2e-harness.ts`.
The goal is to replace its internals with bobina while keeping the existing
wiring (the `/api/e2e-cassette` route and `instrumentation.ts`) intact, so the
rest of the test suite doesn't notice the change.

## Steps

1. **Install bobina** as a git dependency:

   ```sh
   pnpm add github:lukasedw/bobina
   ```

2. **Gut `lib/testing/e2e-harness.ts`** and re-implement it on top of
   `createBobina(...)`. Keep the module's public shape (whatever
   `instrumentation.ts` and the route already import) so callers are unchanged —
   only the body now delegates to bobina:

   ```ts
   import { createBobina, type Bobina } from 'bobina';

   const bobinaConfig = {
     cassetteDir: './tests/e2e/cassettes',
     mode: process.env.E2E_MODE === 'record' ? ('all' as const) : ('none' as const),
     hosts: ['api.anthropic.com', 'openrouter.ai'],
     filters: [
       { placeholder: '<ANTHROPIC_KEY>', value: () => process.env.ANTHROPIC_API_KEY ?? '' },
       { placeholder: '<OPENROUTER_KEY>', value: () => process.env.OPENROUTER_API_KEY ?? '' },
     ],
   };

   export function getHarness(): Bobina {
     return createBobina(bobinaConfig); // globalThis singleton — safe to call anywhere
   }
   ```

3. **Keep the wiring:**
   - `instrumentation.ts` still calls the harness in `register()` (gated on
     `E2E_MODE` + `NEXT_RUNTIME === 'nodejs'`) and `await`s `listen()`.
   - The existing `/api/e2e-cassette` route still switches cassettes — now via
     `getHarness().useCassette(name)`.

   Both resolve to the same bobina singleton because the config matches.

4. **Re-record the existing fixture** against the real APIs, then verify replay:

   ```sh
   E2E_MODE=record pnpm test:e2e   # capture fresh cassettes
   E2E_MODE=replay pnpm test:e2e   # offline, deterministic — must pass with no keys
   ```

5. **Delete the dead VCR code** once replay is green, and commit the regenerated
   cassettes (secrets are redacted by `filters`, so they're safe to commit).

## Notes

- Run E2E against `next build && next start`, never `next dev` (React 19
  hydration races). This was already true for the hand-rolled harness.
- The full Next.js pattern lives in
  [`examples/nextjs-instrumentation/`](../examples/nextjs-instrumentation/) in
  the bobina repo; cocontinuity's wiring should converge on it.

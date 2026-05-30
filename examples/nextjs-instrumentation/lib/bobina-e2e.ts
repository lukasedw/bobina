import type { BobinaConfig } from 'bobina';

/**
 * Single source of truth for the bobina config.
 *
 * Both `instrumentation.ts` and the cassette-switching route import this so they
 * resolve to the SAME `globalThis` singleton. `createBobina()` keys the singleton
 * on `cassetteDir` + `mode` + `hosts`; as long as those three agree, the second
 * caller reuses the engine the first one created (PLAN gotcha #4). Sharing the
 * literal guarantees they never drift apart.
 *
 * `E2E_MODE` is read once, at module eval:
 *   - `record`            → bobina `all`  (capture real traffic, overwrite)
 *   - `replay` / `none`   → bobina `none` (replay only, error on a miss)
 *   - unset               → this module is never imported (bobina stays off)
 */
export const bobinaConfig: BobinaConfig = {
  cassetteDir: './tests/e2e/cassettes',
  mode: process.env.E2E_MODE === 'record' ? 'all' : 'none',
  hosts: ['api.anthropic.com', 'openrouter.ai'],
  filters: [
    { placeholder: '<ANTHROPIC_KEY>', value: () => process.env.ANTHROPIC_API_KEY ?? '' },
    { placeholder: '<OPENROUTER_KEY>', value: () => process.env.OPENROUTER_API_KEY ?? '' },
  ],
};

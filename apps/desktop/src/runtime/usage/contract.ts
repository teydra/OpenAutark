// The anonymous usage count (service.ts) as an optional member of RuntimeServices (module augmentation, like
// work-presence/contract.ts). Wired in compose/services.ts. Missing = not wired (fakes, tests): nothing is counted.
// Owns: the member declaration. Never: behaviour.

import type { UsageCount } from './service.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** 25.11.2026: the anonymous usage count – README › What Autark counts. */
    usage?: UsageCount;
  }
}

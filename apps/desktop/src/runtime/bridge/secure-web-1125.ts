// bridge 0.3.21 of the Secure-web round 25.11.2026 (Konrad's decision 1, after Andrea Griffiths' VM test: in Secure mode
// with the web open everywhere data could leave through any URL). Once per company on this PC, at runtime start beside
// the other bridges (runtime/main.ts): a Secure mode whose stored web switch is 'yes' (all sites) becomes 'chosen' – a
// search stays open, the first visit to a new site asks once and is remembered (webDomains). The security log names the
// update as the one who changed it. The kv mark is set whatever the mode, so the bridge never runs again: whoever sets
// the web back to 'yes' afterwards keeps it. The security section is each PC's own (devices/sync/settings.ts), so the
// mark per PC is the mark per section. A failure is logged and tried again at the next start. Trust AI mode and every
// other switch stay as they are. This file is deleted in the version after the bridge.
// Owns: that one switch and its kv mark. Never: touches another key of the section or a Trust AI mode's settings.

import type { RuntimeServices } from '../contracts.ts';
import type { SecurityActor } from '../../shared/model/security-log.ts';
import { actingAs } from '../settings/security-log.ts';
import { KvRepo } from '../store/kv.ts';

const KV = 'bridge.secure-web-1125';
/** The name the security log shows for the change. */
export const SECURE_WEB_UPDATE: SecurityActor = { kind: 'other', name: 'The 0.3.21 update (Secure mode: the web asks once per new site)' };

/** The bridge (see the header); returns what it did. */
export function runSecureWeb1125(s: Pick<RuntimeServices, 'db' | 'settings' | 'clock' | 'log'>): 'done' | 'switched' | 'failed' {
  try {
    const kv = new KvRepo(s.db);
    if (kv.get<unknown>(KV, 'done')) return 'done';
    const security = s.settings.get().security;
    const switched = security?.mode === 'secure' && security.web === 'yes';
    if (switched) {
      const patch = { security: { web: 'chosen' as const } };
      actingAs(SECURE_WEB_UPDATE, patch, () => s.settings.update(patch));
      s.log.info('secure-web-1125 bridge', { web: 'chosen' });
    }
    kv.set(KV, 'done', { switched }, s.clock.now());
    return switched ? 'switched' : 'done';
  } catch (error) {
    s.log.warn('secure-web-1125 bridge failed', { error: String((error as Error)?.message ?? error) });
    return 'failed';
  }
}

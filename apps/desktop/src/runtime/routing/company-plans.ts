// Konrad 27.11.2026 (ORENDA, company move): an agent of the company this PC's person works for (devices/sync/employee.ts
// fromEmployer – the company moved it here) runs here only on the plans that company shares with this PC (planFrom: the
// row came from the employer, devices/sync/logins.ts brings its login) – never on the person's own plans, keys or local
// models. Its route sees the accounts through this view, so the pool, its stand-ins and the reason name the company's
// plans only; with none switched on here the turn fails with a visible reason that needs a setup (no outage that heals
// itself), as a turn without any account does. The person's own agents and the CEO's PCs see every account, as before.
// Owns: that view and its message. Never: changes an account, or decides where an agent runs (devices/sync/home.ts).

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { Account } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { fromEmployer, planFrom } from '../devices/sync/employee.ts';

/** The reason of a company agent's turn on a PC without a plan of its company. */
export const companyPlansMessage = (name: string) => `${name} works for the company and runs here only on plans the company shares with this PC – none is switched on here yet.`;

/** What a route of `agent` sees: every account, or for a company agent on an employee's PC only the company's plans (throws when none is on). */
export function companyPlansOnly(s: RuntimeServices, agent: Pick<RouteRequest['agent'], 'id' | 'name'>): RuntimeServices {
  if (!fromEmployer(s.db, agent.id)) return s;
  const ours = (account: Account) => planFrom(s.db, account.id) !== undefined;
  const base = s.accounts;
  const accounts = new Proxy(base, {
    get(target, key) {
      if (key === 'list') return () => target.list().filter(ours);
      if (key === 'candidates') return (...args: Parameters<typeof target.candidates>) => target.candidates(...args).filter(ours);
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  if (!accounts.list().some((account) => account.enabled)) throw new WorkforceError('unavailable', companyPlansMessage(agent.name), { details: { setup: true } });
  return new Proxy(s, { get: (target, key) => (key === 'accounts' ? accounts : Reflect.get(target, key)) });
}

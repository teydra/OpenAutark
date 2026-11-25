// Starts the packaged AppImage once and prints which safeStorage backend Electron picked and whether it can encrypt.
// usage (cwd apps/desktop, WORKFORCE_APPIMAGE=...): node probe-backend.mjs <label> [--no-bus] [electron args...]
// Owns: the measurement only. It stores no value in the keyring and touches no real profile (temporary data folder).
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { _electron: electron } = require('playwright-core');
const { testNetworkEnv } = await import(new URL('file://' + path.join(process.cwd(), 'scripts/test-network-env.mjs').replaceAll('\\', '/')));

const [label, ...rest] = process.argv.slice(2);
const noBus = rest.includes('--no-bus');
const args = rest.filter(a => a !== '--no-bus');
const image = path.resolve(process.env.WORKFORCE_APPIMAGE ?? '');
const root = await mkdtemp(path.join(os.tmpdir(), 'autark-backend-probe-'));
try {
  const env = testNetworkEnv(path.join(root, 'profile'), undefined, { inherited: { ...process.env, WORKFORCE_FAKE_ENGINE: '1' } });
  delete env.ELECTRON_RUN_AS_NODE;
  if (noBus) env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + path.join(root, 'no-bus');
  const app = await electron.launch({ executablePath: image, args, env, timeout: 40_000 });
  try {
    const seen = await app.evaluate(async ({ app, safeStorage }) => ({
      packaged: app.isPackaged,
      electron: process.versions.electron,
      available: safeStorage.isEncryptionAvailable(),
      asyncAvailable: await safeStorage.isAsyncEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend(),
      appImageEnv: Boolean(process.env.APPIMAGE),
      // synthetic value only: does the real OS call work, and can it be read back?
      asyncRoundTrip: await (async () => {
        try {
          const cipher = await safeStorage.encryptStringAsync('synthetic-probe-value');
          const back = await safeStorage.decryptStringAsync(cipher);
          return back.result === 'synthetic-probe-value' ? 'ok' : 'mismatch';
        } catch (error) { return 'error: ' + String(error.message).slice(0, 120); }
      })(),
    }));
    console.log(`PROBE ${label}: ${JSON.stringify({ args, noBus, ...seen })}`);
    // what the person sees: the headline of the first window (a repair card or the normal shell)
    try {
      const page = await app.firstWindow({ timeout: 25_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 6_000));
      const text = await page.evaluate(() => ({ title: document.title, shell: Boolean(document.querySelector('.shell')), repair: Boolean(document.querySelector('.repair-card')), heading: [...document.querySelectorAll('h1,h2')].map(h => h.textContent.trim()).slice(0, 3) }));
      console.log(`WINDOW ${label}: ${JSON.stringify(text)}`);
    } catch (error) {
      console.log(`WINDOW ${label}: no window within 25 s (${String(error.message).split('\n')[0]})`);
    }
  } finally {
    await app.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

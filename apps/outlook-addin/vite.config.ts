import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Two HTML entry points:
 *   - index.html         → the task pane (React app — the redesigned
 *                          Detect → Review → Confirm → Sent flow).
 *   - auth-callback.html → tiny vanilla bridge page that runs inside the
 *                          sign-in dialog popup. It reads the JWT out of
 *                          the URL fragment (set by the rhud.net /login
 *                          redirect) and hands it back to the parent task
 *                          pane via Office.context.ui.messageParent().
 *                          Kept non-React on purpose — it's ~20 lines and
 *                          has no UI to speak of.
 *
 * Both are emitted to dist/ as plain static files. The Caddy container at
 * infra/prod serves dist/ on addin.rhud.net.
 *
 * Office add-ins require HTTPS for both prod and dev. For local development,
 * `pnpm --filter @rhud/outlook-addin dev` runs Vite with a self-signed cert.
 * You'll need to trust that cert in your OS keychain before Outlook will
 * load the manifest.
 */
export default defineConfig({
  root: '.',
  base: '/',
  publicDir: 'public',
  plugins: [react()],
  server: {
    port: 4000,
    https: {},
    host: '0.0.0.0',
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        taskpane: resolve(__dirname, 'index.html'),
        authCallback: resolve(__dirname, 'auth-callback.html'),
      },
    },
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Relative base: the same bundle is served at / under `npm run dev` and at
  // /data/scriptide/ on a gateway, and must resolve its own assets in both.
  base: './',
  build: {
    // Must line up with ScriptIdeModuleHook#getMountedResourceFolder() ("mounted")
    // and web/build.gradle.kts's projectOutput, or the gateway serves nothing.
    outDir: 'build/generated-resources/mounted',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Cap the worker pool. Vitest defaults to roughly one worker per core; on
    // this machine, which also runs several Ignition containers, that starves
    // the main process and it then fails its own RPC — reported as a red build
    // with a green test list, which is the worst possible failure mode for the
    // check that gates every release. Learned on web-designer 14/08/2026.
    poolOptions: { threads: { maxThreads: 8 } },
  },
});

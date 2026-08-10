import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mailApp = resolve(here, '../../apps/mail');
const mailDep = (p: string) => resolve(mailApp, 'node_modules', p);

export default defineConfig({
  // apps/mail components are authored for the automatic JSX runtime (the
  // app's vite/react plugin provides it); mirror that here so specs can
  // import the real provider/root wiring.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      // apps/mail modules import via '@/…'; resolve those the way the app does.
      { find: /^@\//, replacement: mailApp + '/' },
      // React singletons: components under test resolve react from
      // apps/mail — specs must share those instances or hooks break.
      { find: /^react$/, replacement: mailDep('react') },
      { find: /^react\/jsx-runtime$/, replacement: mailDep('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/, replacement: mailDep('react/jsx-dev-runtime') },
      { find: /^react-dom$/, replacement: mailDep('react-dom') },
      { find: /^react-dom\/client$/, replacement: mailDep('react-dom/client') },
      { find: /^react-dom\/test-utils$/, replacement: mailDep('react-dom/test-utils') },
      // Single resolution for idb-keyval so a spec's vi.mock of it also
      // intercepts apps/mail's own imports of the same package.
      { find: /^idb-keyval$/, replacement: mailDep('idb-keyval') },
    ],
  },
  test: {
    environment: 'node',
    include: ['unit/**/*.spec.ts'],
  },
});

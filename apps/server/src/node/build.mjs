/**
 * esbuild bundle of the server for Node.js (Path B migration).
 *
 * Why bundle instead of a tsx loader: bundling reproduces the module-interop
 * semantics the codebase was written against (CJS named imports, raw-TS
 * packages, `.sql` imports as text). tsx's loader hooks break
 * cjs-module-lexer named-export detection for several CJS deps.
 *
 *   node src/node/build.mjs          # build once  -> dist-node/server.mjs
 *   node src/node/build.mjs --watch  # rebuild on change
 */
import { context, build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const options = {
  entryPoints: {
    server: resolve(serverDir, 'src/node/entry.ts'),
    worker: resolve(serverDir, 'src/worker/index.ts'),
  },
  outdir: resolve(serverDir, 'dist-node'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // .sql files import as their text contents (drizzle migration snapshots).
  loader: { '.sql': 'text' },
  // ESM output + bundled CJS deps that call require() at runtime need a
  // require shim; standard esbuild-for-node banner.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build] watching for changes...');
} else {
  await build(options);
}

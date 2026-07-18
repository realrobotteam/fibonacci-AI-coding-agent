// esbuild config for compiling the VS Code extension host (Node-side) TypeScript.
// Output: dist/extension.js (referenced by package.json "main").
//
// Only `vscode` is external (provided by the VS Code extension host runtime).
// Everything else — `openai`, `@modelcontextprotocol/sdk`, `diff`, `zustand`,
// etc. — is bundled into extension.js so the packaged .vsix works without a
// node_modules folder on the user's machine.
const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
  loader: { '.svg': 'text' },
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching extension host...');
  } else {
    await esbuild.build(options);
    console.log('[esbuild] built extension host.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

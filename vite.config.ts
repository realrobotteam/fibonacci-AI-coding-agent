import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Vite config for building the React webview (RTL/Persian support).
// Output goes to `dist/webview` so the extension host can serve it via vscode-webview.
export default defineConfig({
  root: path.resolve(__dirname, 'src/webview'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/webview'),
      '@shared': path.resolve(__dirname, 'src/types'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    // Disable module preload polyfill — VS Code webviews can't register a
    // service worker, and Vite's polyfill uses that for preload detection.
    modulePreload: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/webview/main.tsx'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        // Single bundle, no dynamic imports → no extra chunks, no preloads.
        manualChunks: undefined,
      },
    },
  },
  css: {
    postcss: path.resolve(__dirname, 'postcss.config.js'),
  },
});

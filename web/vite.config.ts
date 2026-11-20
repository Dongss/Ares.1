import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webDir = fileURLToPath(new URL('.', import.meta.url));

// The dashboard. `npm run build` writes it to dist/web, which the Master serves.
// `npm run dev:web` serves it with hot reload and forwards /api to a Master on port 4870.
export default defineConfig({
  root: webDir,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 4871,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.ARES1_PORT ?? 4870}` },
    },
  },
});

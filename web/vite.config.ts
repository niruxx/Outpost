import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'spice-webcrypto-random',
    // Replace the upstream legacy Math.random/RC4 entropy pool for RSA ticket padding.
    transform(_source, id) {
      if (!id.replace(/\\/g, '/').endsWith('/@spice-project/spice-html5/src/thirdparty/rng.js')) return;
      return { code: `export class SecureRandom {
        nextBytes(bytes) {
          const random = new Uint8Array(bytes.length);
          globalThis.crypto.getRandomValues(random);
          for (let i = 0; i < bytes.length; i++) bytes[i] = random[i];
        }
      }`, map: null };
    },
  }],
  optimizeDeps: {
    // Keep SPICE source in the transform pipeline so development uses WebCrypto too.
    exclude: ['@spice-project/spice-html5'],
    esbuildOptions: { target: 'es2022' },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8642',
      '/ws': {
        target: 'ws://localhost:8642',
        ws: true,
      },
    },
  },
  build: {
    // noVNC 1.7 probes browser codecs with top-level await.
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});

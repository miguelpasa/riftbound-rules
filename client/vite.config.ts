import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The engine is consumed through the npm workspace link `@riftbound/engine`
// (see engine/package.json "exports"), so no manual alias is needed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Vendor code gets its own files so the app chunk stays under the 500 kB warning limit and the
    // libraries cache separately from the game code.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\/](react|react-dom|scheduler)[\/]/,
              priority: 20,
            },
            { name: 'vendor-peer', test: /node_modules[\/]peerjs[\/]/, priority: 20 },
          ],
        },
      },
    },
  },
});

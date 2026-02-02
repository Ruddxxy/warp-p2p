import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true
      }
    }
  },
  define: {
    'import.meta.env.VITE_SIGNALING_URL': JSON.stringify(
      process.env.VITE_SIGNALING_URL || 'ws://localhost:8080/ws'
    )
  }
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // The API is a separate process in development. Proxying rather than pointing the client at
    // another origin keeps the session cookie same-site, which is what the cookie's SameSite=Lax
    // attribute assumes — a cross-origin dev setup would work locally and then behave differently
    // in production, which is the worst kind of difference.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
});

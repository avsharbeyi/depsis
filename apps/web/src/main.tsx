import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

/**
 * Registered in production only.
 *
 * A service worker in development serves yesterday's bundle from cache and makes every change look
 * like it did not take — the single most common way a service worker costs more than it earns.
 * `import.meta.env.PROD` is Vite's build-time constant, so the whole block is removed from the dev
 * bundle rather than merely skipped at runtime.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      // Not fatal, and not silent either. The application works without it; what would be wrong is
      // an installability feature failing with nothing anywhere saying so.
      console.warn('service worker registration failed', error);
    });
  });
}

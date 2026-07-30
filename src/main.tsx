import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './ui/App.js';
import { startPwa } from './pwa/lifecycle.js';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// Fire and forget: the service-worker policy must never block or fail the render.
void startPwa();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

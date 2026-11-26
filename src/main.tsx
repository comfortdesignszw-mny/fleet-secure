import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (import.meta.env.DEV && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw-notifications.js', { scope: '/' }).catch(() => undefined);
  });
}

createRoot(document.getElementById('root')!).render(<App />);

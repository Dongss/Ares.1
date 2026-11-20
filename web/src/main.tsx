import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_LANG } from '../../src/i18n.js';
import { App } from './App.js';
import { applyLang, storedLang } from './lib/lang.js';
import './styles.css';

// The Master's language replaces the default once it is known (App), unless this browser chose.
applyLang(storedLang() ?? DEFAULT_LANG);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

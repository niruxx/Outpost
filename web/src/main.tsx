import React from 'react';
import { applyEffects, storedEffects } from './lib/perf.js';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { applyTheme, applyWallpaper, storedTheme, storedWallpaper } from './lib/theme.js';
import './index.css';

// Before the first render, so the page never flashes the default theme.
applyTheme(storedTheme());
applyWallpaper(storedWallpaper());
applyEffects(storedEffects());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

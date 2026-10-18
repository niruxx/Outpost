import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { applyTheme, storedTheme } from './lib/theme.js';
import './index.css';

// Before the first render, so the page never flashes the default theme.
applyTheme(storedTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

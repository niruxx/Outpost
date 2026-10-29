import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Layout } from './Layout.js';
import { Icon } from './icons.js';
import { t } from '../i18n/index.js';

export function SystemLayout({ children }: { children: ReactNode }) {
  return <Layout>
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-8">
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-medium text-ink-100">{t('System')}</h1>
        <nav aria-label="System sections" className="inline-flex max-w-full gap-1 rounded-full border border-surface-700 bg-surface-900 p-1">
          {([
            { to: '/configuration', label: 'Configuration', icon: 'configuration' },
            { to: '/configuration/operations', label: 'Operations', icon: 'node' },
          ] as const).map(tab => <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => `inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 sm:px-6 ${isActive ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-400 hover:bg-surface-800 hover:text-ink-100'}`}>
            <Icon name={tab.icon} className="h-4 w-4 shrink-0" />{t(tab.label)}
          </NavLink>)}
        </nav>
      </div>
      {children}
    </div>
  </Layout>;
}

import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Layout } from './Layout.js';
import { Icon } from './icons.js';
import { t } from '../i18n/index.js';

const TABS = [
  { to: '/configuration', label: 'Configuration', icon: 'configuration', subtitle: 'Panel-wide settings for this Outpost host.' },
  { to: '/configuration/operations', label: 'Operations', icon: 'node', subtitle: 'Hosts, network assignments, Steam accounts and server modpacks.' },
] as const;

/** One header for the System area: the current page's title on the left, its sibling pages as tabs. */
export function SystemLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const current = TABS.find((tab) => tab.to === pathname.replace(/\/$/, '')) ?? TABS[0];
  return <Layout>
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <motion.header initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="ui-page-header flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="ui-page-title text-[28px] font-normal leading-9 text-ink-50">{t(current.label)}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-400">{t(current.subtitle)}</p>
        </div>
        <nav aria-label={t('System sections')} className="inline-flex max-w-full gap-1 rounded-full border border-surface-700 bg-surface-900 p-1">
          {TABS.map(tab => <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => `inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 ${isActive ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-400 hover:bg-surface-800 hover:text-ink-100'}`}>
            <Icon name={tab.icon} className="h-4 w-4 shrink-0" />{t(tab.label)}
          </NavLink>)}
        </nav>
      </motion.header>
      {children}
    </div>
  </Layout>;
}

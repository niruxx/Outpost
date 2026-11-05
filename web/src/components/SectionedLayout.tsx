import { useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LayoutGroup, motion } from 'framer-motion';
import { Icon, type IconName } from './icons.js';
import { t } from '../i18n/index.js';

export interface Section {
  id: string;
  label: string;
  icon: IconName;
  description?: string;
  /** Rendered with a red label and kept last — for irreversible actions. */
  danger?: boolean;
  content: ReactNode;
}

/**
 * Long settings pages split into sections with a sticky side menu (a chip row on small screens).
 * The active section lives in `?section=` so it can be linked and survives reloads. Every
 * section stays mounted and is only hidden, so unsaved edits survive switching between them.
 */
export function SectionedLayout({ sections, layoutId }: { sections: Section[]; layoutId: string }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('section');
  const active = sections.find((s) => s.id === requested) ?? sections[0];

  // Jump to the top of the content when the section changes, not when the page first opens.
  useEffect(() => {
    if (requested) document.querySelector('.ui-main')?.scrollTo({ top: 0 });
  }, [requested]);

  function choose(id: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id === sections[0]?.id) next.delete('section');
      else next.set('section', id);
      return next;
    }, { replace: true });
  }

  if (!active) return null;

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
      <LayoutGroup id={layoutId}>
        <nav
          aria-label={t('Sections')}
          className="ui-section-nav -mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 lg:sticky lg:top-6 lg:mx-0 lg:w-56 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0"
        >
          {sections.map((s) => {
            const isActive = s.id === active.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => choose(s.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`state-layer relative flex shrink-0 items-center gap-3 whitespace-nowrap rounded-full px-4 py-2.5 text-left text-sm font-medium transition-colors lg:rounded-2xl ${
                  s.danger ? 'lg:mt-3' : ''
                } ${isActive ? 'text-secondary-on-container' : s.danger ? 'text-red-400' : 'text-ink-300'}`}
              >
                {isActive && (
                  <motion.span
                    layoutId={`${layoutId}-indicator`}
                    className="absolute inset-0 rounded-full bg-secondary-container lg:rounded-2xl"
                    transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                  />
                )}
                <Icon name={s.icon} className="relative z-10 h-[18px] w-[18px] shrink-0" />
                <span className="relative z-10">{t(s.label)}</span>
              </button>
            );
          })}
        </nav>
      </LayoutGroup>

      <div className="min-w-0 flex-1">
        {sections.map((s) => (
          <section key={s.id} hidden={s.id !== active.id} aria-label={t(s.label)}>
            {s.id === active.id && (
              <motion.header initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="mb-4">
                <h2 className={`text-xl font-medium ${s.danger ? 'text-red-400' : 'text-ink-50'}`}>{t(s.label)}</h2>
                {s.description && <p className="mt-1 text-sm text-ink-400">{t(s.description)}</p>}
              </motion.header>
            )}
            <div className="stagger space-y-5">{s.content}</div>
          </section>
        ))}
      </div>
    </div>
  );
}

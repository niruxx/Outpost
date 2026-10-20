import { useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import { motion } from 'framer-motion';
import type { ServerRecord } from '../api/types.js';
import { Modal } from './ui.js';
import { GameTile, type GameKind } from './GameArt.js';
import { CreateServerModal } from './CreateServerModal.js';
import { CreateContainerModal } from './CreateContainerModal.js';
import { CreateFromTemplateModal } from './CreateFromTemplateModal.js';
import { api } from '../api/client.js';
import { EMPHASIZED } from './motion.js';
import { useAuth } from '../state/AuthContext.js';

type Choice = 'game' | 'app' | 'portainer' | 'container' | 'custom' | 'template';

const CHOICES: { id: Choice; title: string; description: string; kind: GameKind }[] = [
  {
    id: 'app',
    title: 'App from the catalog',
    description: 'Web apps, databases, media servers and tools — Nginx, PostgreSQL, Jellyfin, Uptime Kuma…',
    kind: 'app:app',
  },
  {
    id: 'portainer',
    title: 'Portainer',
    description: 'A full container-management UI for this host, set up in one click.',
    kind: 'app:manager',
  },
  {
    id: 'container',
    title: 'Docker container',
    description: 'Run any image from Docker Hub, GHCR or your own registry.',
    kind: 'docker',
  },
  {
    id: 'game',
    title: 'Game server',
    description: 'Minecraft Java & Bedrock or Steam dedicated servers — installed, updated and managed for you.',
    kind: 'minecraft-java',
  },
  {
    id: 'template',
    title: 'From a template',
    description: 'A saved or imported setup — game, settings and config files ready to go.',
    kind: 'app:template',
  },
  {
    id: 'custom',
    title: 'Custom process',
    description: 'Any Linux binary or shell script, with your own start, stop and restart commands.',
    kind: 'custom',
  },
];

/** Entry point for creating anything: picks the kind of instance, then opens the right dialog. */
export function NewInstanceModal({
  open,
  onClose,
  onCreated,
  only,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (s: ServerRecord) => void;
  /** Restrict the choices (e.g. the Docker page only offers container kinds). */
  only?: Choice[];
}) {
  const { user, creation } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [choice, setChoice] = useState<Choice | null>(null);
  const canGame = !!creation?.allowedPlatforms.some((p) => p === 'java' || p === 'bedrock' || p === 'steam');
  const [templateCount, setTemplateCount] = useState(0);
  useEffect(() => {
    if (!open) return;
    api
      .get<{ templates: unknown[] }>('/templates')
      .then((r) => setTemplateCount(r.templates.length))
      .catch(() => setTemplateCount(0));
  }, [open]);

  const containers = isAdmin ? 'any' : creation?.canCreate ? creation.containers : 'none';
  const available: Record<Choice, boolean> = {
    game: canGame,
    app: containers !== 'none',
    portainer: containers !== 'none' && (isAdmin || !!creation?.engineSocket),
    container: containers === 'any',
    custom: isAdmin,
    template: templateCount > 0 && (isAdmin || !!creation?.canCreate),
  };
  const reason: Record<Choice, string> = {
    game: 'Your account can’t create game servers',
    app: 'Ask an admin for container access',
    portainer: 'Needs Portainer (container engine) access — ask an admin',
    container: containers === 'catalog' ? 'Your account runs catalog apps only' : 'Ask an admin for container access',
    custom: 'Admins only — it runs code directly on the host',
    template: templateCount === 0 ? 'No templates yet — import one under Configuration' : 'Your account can’t create instances',
  };
  const options = CHOICES.filter((c) => (!only || only.includes(c.id)) && (c.id !== 'template' || templateCount > 0 || isAdmin)).map((c) => ({ ...c, available: available[c.id] }));

  // A single available option skips the picker.
  const usable = options.filter((o) => o.available);
  const effective: Choice | null = choice ?? (open && usable.length === 1 && options.length === 1 ? usable[0].id : null);

  function close() {
    setChoice(null);
    onClose();
  }

  return (
    <>
      <Modal open={open && !effective} onClose={close} title="New instance" size="lg">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {options.map((o, i) => (
            <motion.button
              key={o.id}
              type="button"
              disabled={!o.available}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04, duration: 0.3, ease: EMPHASIZED }}
              whileTap={o.available ? { scale: 0.98 } : undefined}
              onClick={() => setChoice(o.id)}
              className="state-layer flex items-start gap-3 rounded-2xl bg-surface-850 p-4 text-left disabled:cursor-not-allowed disabled:opacity-50"
            >
              <GameTile kind={o.kind} className="h-11 w-11" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-50">{t(o.title)}</span>
                <span className="mt-0.5 block text-xs text-ink-400">{t(o.description)}</span>
                {!o.available && (
                  <span className="mt-1.5 block text-[11px] font-medium text-yellow-400">
                    {reason[o.id]}
                  </span>
                )}
              </span>
            </motion.button>
          ))}
        </div>
      </Modal>

      <CreateServerModal open={open && (effective === 'game' || effective === 'custom')} mode={effective === 'custom' ? 'custom' : 'game'} onClose={close} onCreated={onCreated} />
      <CreateFromTemplateModal open={open && effective === 'template'} onClose={close} onCreated={onCreated} />
      <CreateContainerModal
        open={open && (effective === 'app' || effective === 'portainer' || effective === 'container')}
        initialTemplate={effective === 'portainer' ? 'portainer' : effective === 'container' ? 'blank' : undefined}
        sections={effective === 'app' ? ['Platform tools', 'Web & apps', 'Databases', 'Media & files', 'Games'] : undefined}
        onClose={close}
        onCreated={onCreated}
      />
    </>
  );
}

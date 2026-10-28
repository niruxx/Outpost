import { Navigate, Route, BrowserRouter, Routes, useParams } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import { useEffectsMode } from './lib/perf.js';
import { PublicStatusPage } from './pages/PublicStatusPage.js';
import { I18nProvider } from './i18n/index.js';
import { motion } from 'framer-motion';
import { AuthProvider, useAuth } from './state/AuthContext.js';
import { ToastProvider } from './components/Toast.js';
import { ConfirmProvider } from './components/ConfirmDialog.js';
import { Logo } from './components/Logo.js';
import { LoginPage } from './pages/LoginPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { InstancesPage } from './pages/InstancesPage.js';
import { InstancePage } from './pages/InstancePage.js';
import { ConfigurationPage } from './pages/ConfigurationPage.js';
import { FileManagerPage } from './pages/FileManagerPage.js';
import { DockerPage } from './pages/DockerPage.js';
import { LibvirtPage } from './pages/LibvirtPage.js';
import { StoragePage } from './pages/StoragePage.js';
import { UsersPage } from './pages/UsersPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { FirewallPage } from './pages/FirewallPage.js';
import type { ReactNode } from 'react';
import { lazy, Suspense } from 'react';

const HostTerminalPage = lazy(() => import('./pages/HostTerminalPage.js').then((module) => ({ default: module.HostTerminalPage })));

function FullScreenLoader() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface-950">
      <motion.div
        animate={{ opacity: [1, 0.5, 1] }}
        transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Logo className="h-9 w-9 rounded-lg" />
      </motion.div>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, setupRequired } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (setupRequired) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Old /servers/:id/... links (bookmarks, notifications) now live under /instances. */
function LegacyServerRedirect() {
  const { serverId, '*': rest } = useParams();
  return <Navigate to={`/instances/${serverId}/${rest ?? ''}`} replace />;
}

function AppRoutes() {
  const { setupRequired, loading } = useAuth();
  if (loading) return <FullScreenLoader />;

  return (
    <Routes>
      <Route path="/setup" element={setupRequired ? <SetupPage /> : <Navigate to="/" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/status/:slug" element={<PublicStatusPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <InstancesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/instances/:serverId/*"
        element={
          <RequireAuth>
            <InstancePage />
          </RequireAuth>
        }
      />
      <Route path="/servers/:serverId/*" element={<LegacyServerRedirect />} />
      <Route path="/libvirt/*" element={<RequireAuth><RequireAdmin><LibvirtPage /></RequireAdmin></RequireAuth>} />
      <Route path="/storage" element={<RequireAuth><StoragePage /></RequireAuth>} />
      <Route path="/host-console" element={<RequireAuth><RequireAdmin><Suspense fallback={<FullScreenLoader />}><HostTerminalPage /></Suspense></RequireAdmin></RequireAuth>} />
      <Route
        path="/configuration"
        element={
          <RequireAuth>
            <ConfigurationPage />
          </RequireAuth>
        }
      />
      <Route
        path="/docker"
        element={
          <RequireAuth>
            <DockerPage />
          </RequireAuth>
        }
      />
      <Route
        path="/files/:serverId?"
        element={
          <RequireAuth>
            <FileManagerPage />
          </RequireAuth>
        }
      />
      <Route
        path="/users"
        element={
          <RequireAuth>
            <RequireAdmin>
              <UsersPage />
            </RequireAdmin>
          </RequireAuth>
        }
      />
      <Route
        path="/firewall"
        element={
          <RequireAuth>
            <FirewallPage />
          </RequireAuth>
        }
      />
      <Route
        path="/audit"
        element={
          <RequireAuth>
            <RequireAdmin>
              <AuditPage />
            </RequireAdmin>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** framer-motion follows "Reduce effects" (and the OS setting) for its own animations. */
function EffectsMotion({ children }: { children: ReactNode }) {
  const mode = useEffectsMode();
  return <MotionConfig reducedMotion={mode === 'reduced' ? 'always' : 'user'}>{children}</MotionConfig>;
}

export default function App() {
  return (
    <I18nProvider>
    <EffectsMotion>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AppRoutes />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
    </EffectsMotion>
    </I18nProvider>
  );
}

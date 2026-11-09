/**
 * Every privileged host-administration operation the Admin Mode helper may run (besides file
 * operations), gathered from the per-area modules. None of these modules import panel code.
 */
import { ACCOUNT_OPS } from './hostAccountsOps.js';
import { DIAGNOSTICS_OPS } from './hostDiagnosticsOps.js';
import { NETWORK_OPS } from './hostNetworkOps.js';
import { SECURITY_OPS } from './hostSecurityOps.js';
import { SETTINGS_OPS } from './hostSettingsOps.js';
import { HOST_SYSTEM_OPS } from './hostSystemOps.js';

export const HOST_ADMIN_OPS = {
  ...HOST_SYSTEM_OPS,
  ...ACCOUNT_OPS,
  ...NETWORK_OPS,
  ...SETTINGS_OPS,
  ...SECURITY_OPS,
  ...DIAGNOSTICS_OPS,
};

export type HostAdminOp = keyof typeof HOST_ADMIN_OPS;
type FirstArg<F> = F extends (a: infer A, ...rest: never[]) => unknown ? (unknown extends A ? Record<string, never> : A) : Record<string, never>;
/** Operations without arguments take `{}`. */
export type HostAdminArgs<K extends HostAdminOp> = (typeof HOST_ADMIN_OPS)[K] extends () => unknown ? Record<string, never> : FirstArg<(typeof HOST_ADMIN_OPS)[K]>;
export type HostAdminResult<K extends HostAdminOp> = Awaited<ReturnType<(typeof HOST_ADMIN_OPS)[K]>>;

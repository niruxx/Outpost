import type { ServerRecord } from '../types/index.js';
import { launchConfigOf } from './launchConfig.js';
import { dockerConfigOf } from './containerService.js';
import { findPresetFor } from './steamGames.js';

/** Which protocol players connect to an instance's main port over. */
export function instancePortProtocol(server: ServerRecord): 'tcp' | 'udp' {
  switch (server.platform) {
    case 'java':
      return 'tcp';
    case 'bedrock':
      return 'udp';
    case 'custom':
      return launchConfigOf(server).protocol ?? 'tcp';
    case 'docker':
      return dockerConfigOf(server)?.ports[0]?.protocol ?? 'tcp';
    default:
      return findPresetFor(server)?.portProtocol ?? 'udp';
  }
}

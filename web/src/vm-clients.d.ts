declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password: string } });
    scaleViewport: boolean; resizeSession: boolean;
    disconnect(): void;
    sendCtrlAltDel(): void;
  }
}
declare module '@spice-project/spice-html5' {
  export class SpiceMainConn {
    constructor(options: { uri: string; password: string; screen_id: string; onsuccess: () => void; onerror: (error: Error) => void });
    stop(): void;
  }
  export function sendCtrlAltDel(connection: SpiceMainConn): void;
}

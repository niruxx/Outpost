/* Outpost extension page bridge v1. Inline this file inside the sandboxed page HTML. */
(function () {
  'use strict';
  const pending = new Map();
  window.addEventListener('message', function (event) {
    if (event.source !== parent || event.data?.type !== 'outpost.extension.response') return;
    const request = pending.get(event.data.requestId);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(event.data.requestId);
    event.data.error ? request.reject(new Error(event.data.error)) : request.resolve(event.data.result);
  });
  window.outpost = Object.freeze({
    sdkVersion: 1,
    invoke: function (action, input) {
      return new Promise(function (resolve, reject) {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(function () { pending.delete(requestId); reject(new Error('Extension action timed out')); }, 30000);
        pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
        parent.postMessage({ type: 'outpost.extension.invoke', sdkVersion: 1, requestId: requestId, action: action, input: input || {} }, '*');
      });
    }
  });
}());

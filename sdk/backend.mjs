import crypto from 'node:crypto';
/** Use with an Express JSON parser on an extension's own backend, never in the panel process. */
export function extensionBackend({ secret, actions }) {
  if (!secret || secret.length < 24) throw new Error('An extension backend secret of at least 24 characters is required');
  return async (req, res) => {
    const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(req.headers.authorization ?? '');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return res.status(401).json({ error: 'Invalid extension authentication' });
    const body = req.body;
    if (body?.sdkVersion !== 1 || typeof body.action !== 'string' || !Object.hasOwn(actions, body.action)) return res.status(400).json({ error: 'Unsupported SDK/action' });
    try { res.json(await actions[body.action](Object.freeze({ ...body.context }), body.input)); }
    catch { res.status(500).json({ error: 'Extension backend action failed' }); }
  };
}

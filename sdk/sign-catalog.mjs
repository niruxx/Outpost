// node sdk/sign-catalog.mjs manifest.json publisher-private.pem catalog.signed.json
import fs from 'node:fs';
import crypto from 'node:crypto';
const [manifestFile, keyFile, output] = process.argv.slice(2);
if (!manifestFile || !keyFile || !output) throw new Error('Usage: node sdk/sign-catalog.mjs manifest.json private.pem output.json');
const manifest = fs.readFileSync(manifestFile, 'utf8'); JSON.parse(manifest);
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 publisher key is required');
const signature = crypto.sign(null, Buffer.from(manifest), key).toString('base64');
fs.writeFileSync(output, JSON.stringify({ manifest, signature }, null, 2));
console.log('Signed catalog written. Keep the private key off the hosting server.');

# Outpost extension SDK v1

An extension is a JSON manifest using [`manifest.schema.json`](manifest.schema.json). Use numeric `major.minor.patch` versions, declare SDK `1` and a supported panel version range. Import/review it under Configuration → Operations → Extension SDK. Review is bound to the normalized manifest SHA-256. Installation and update both leave it disabled.

Start with [`examples/instance-overview.json`](examples/instance-overview.json). Its inline page calls the `summary` action and receives only the authorized instance summary. For a fuller page, inline [`browser.js`](browser.js) and use `window.outpost.invoke('action-id', input)`. The manifest's `html` is the complete page content; it can contain inline CSS/JavaScript. Network scripts/imports, direct fetch, forms, same-origin access and panel-token access are unavailable in the iframe. Use declared actions to communicate with the parent panel. A page with an empty permission list is administrator-only. Other pages require an authorized instance context and every listed permission. Each action is independently authorized on the server using the current account and grants.

Native action kinds:

| Kind | Required declaration | Input / output |
| --- | --- | --- |
| `instance.summary` | `files.read` | Selected instance's ID, name, platform, status, version and primary port only |
| `files.read` | `files.read` | `{ "path": "server.properties" }`, confined to the selected instance |
| `console.command` | `console` | `{ "command": "say Hello" }`, one bounded command |
| `backend.request` | Explicit permission list; empty means admin only | POST to manifest `backend.url + action.backendPath` |

Backend capabilities run in an **external service**, not the panel's Node process. Use [`backend.mjs`](backend.mjs) as an authenticated Express handler. Set `OUTPOST_EXTENSION_SECRET_<EXTENSION_ID_IN_UPPER_SNAKE_CASE>` on Outpost and configure the same secret in that service. For example, `example-tools` uses `OUTPOST_EXTENSION_SECRET_EXAMPLE_TOOLS`. Backend input contains `sdkVersion`, `extension`, `action`, `context: {userId, serverId}` and `input`; it never receives the caller's panel token or node credentials. Treat context as authenticated only after checking the shared backend secret. Endpoints require HTTPS except literal loopback for development, do not follow redirects and have response/time limits. Empty permissions do not grant ordinary users a global backend action. The admin explicitly trusts this service with the declared operation.

`gameAdapters` extend the native Steam preset/settings UI. An adapter ID must start with `x-<extension-id>-`; declare Steam `appId`, supported `hosts` (`linux`/`win32`), relative `executable` paths, `launchArgs`, a relative config `file`, supported native `format`, typed `fields` and `notes`. Formats in v1 are `source`, `quake`, `kv`, `ini`, `xml`, `commands`, `arma`. Field types are `text`, `password`, `number`, `boolean`, `select`; declare defaults and optional bounds/options. Use `{port}`, `{name}` and `{setting.FIELD_KEY}` in argument elements. Native settings are prepared at launch after users opt into managed settings in the game settings UI. No arbitrary installer/process hooks, panel-process JavaScript, package-manager execution or custom map-archive handlers are accepted. A publisher must test the real executable, native file format, ports, dependencies and game versions it declares.

To publish a community source:

1. Host exact immutable template/extension JSON bytes over HTTPS and calculate their SHA-256.
2. Write a manifest with `schemaVersion: 1`, `publisher`, ISO `generatedAt`, and `entries: [{id,name,kind,releases:[{version,url,sha256,summary}]}]`. `kind` is `template` or `extension`; an extension's package version must equal the release pin.
3. Generate an Ed25519 key pair and keep the private key off the public host. Export the final 32 bytes of its SPKI public DER as 64 hex characters for administrators to trust.
4. Run `node sdk/sign-catalog.mjs manifest.json private-key.pem signed-catalog.json`, then publish the signed envelope. The signature covers the exact UTF-8 `manifest` string in that envelope; do not reserialize it after signing.
5. Distribute your public key through an independently verifiable channel. Administrators add that key/source, verify the signature, then review/install an exact version. Publish a new version for changed package bytes. Never mutate an existing version's digest or kind.

Signed catalogs can carry ordinary existing Outpost templates as well as extensions. Updates retain the source fingerprint, publisher, version, URL and package digest. Source disablement prevents future imports; it does not silently replace or remove installed versions. This is provenance verification, not a security audit or certification service.

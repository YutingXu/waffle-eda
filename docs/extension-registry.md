# Extension registry

_Status: the index format and the in-app **Browse Extensions** view are implemented as a local prototype (2026-11-19). Signing, revocation and the review pipeline are designed below but not built yet._

A registry is a static JSON **index** plus the extension packages it points to. Anyone can host one (a Git repository with GitHub Pages, any static web server, or a folder on disk), and anyone can mirror one. Waffle reads it, shows each extension's permissions, checks each package against the SHA-256 in the index, and installs through the same permission prompt as **Install from package…**.

## Using a registry

Open **Tools › Extensions…** and choose **Browse…**.

- **It is off by default.** Until you enter a registry URL and press **Save**, Waffle makes no network request for extensions at all. Clearing the URL turns it off again.
- With a URL set, Waffle fetches that one index when the Browse view opens or you press **Refresh**, and a package only when you press **Install**. Requests carry no cookies, no credentials and no referrer, and bypass the cache. Nothing else is contacted.
- **Open index file…** reads an index from disk instead, with no network use. Each **Install from file…** then asks for the package file, and that file is checked against the index the same way.
- Each extension shows its publisher, id, version, licence, description, the **permissions it requests** (with `network:` hosts, `write:edits` and `run:external` highlighted), the package address, its SHA-256, its source address and its signature state, before anything is downloaded.

Registry URLs and package addresses must use `https://`. `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, for testing a registry on your own computer. Addresses with a user name or password are refused. A registry served to Waffle's app page must allow cross-origin reads (`Access-Control-Allow-Origin: *`), which GitHub Pages and most static hosts do.

## Index format (version 1)

```json
{
  "format": "atrium-extension-index",
  "version": 1,
  "name": "Waffle community extensions",
  "updated": "2026-11-19T00:00:00Z",
  "extensions": [
    {
      "id": "acme.net-length-report",
      "name": "Net Length Report",
      "publisher": "ACME",
      "version": "1.2.0",
      "apiVersion": 1,
      "description": "Routed length per net, as a panel.",
      "permissions": ["read:project", "ui:panel", "ui:command"],
      "download": "packages/acme.net-length-report-1.2.0.zip",
      "size": 18234,
      "sha256": "9f2c4e…64 lowercase hex digits…",
      "bundleSha256": null,
      "source": "https://github.com/acme/net-length-report",
      "license": "MIT",
      "signature": null
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `format`, `version` | yes | `"atrium-extension-index"` and `1`. Other values are refused. |
| `name`, `updated` | no | Shown in the Browse view. |
| `extensions` | yes | Up to 5,000 entries. The same `id` may appear once per `version`; Browse shows the newest. |
| `id` | yes | `publisher.name`, as in `waffle-extension.json`. |
| `name`, `publisher` | yes | Display name and publisher. |
| `version` | yes | Semantic version, as in the manifest. |
| `apiVersion` | yes | `1`. |
| `permissions` | yes | Exactly the manifest's `permissions`, each once. Shown before install; a package that asks for anything else is refused. |
| `download` | yes | The package: a `.zip` (optionally with one top-level folder) or a `.waffle-extension` bundle (`{"manifest", "files"}`). An absolute `https://` URL, or a path relative to the index URL. A local index needs absolute URLs. |
| `sha256` | yes | SHA-256 of the package file's bytes, as `shasum -a 256` prints it (lowercase hex). |
| `size` | no | Package size in bytes (at most 32 MB). When present, a package of any other size is refused. |
| `bundleSha256` | no | The canonical bundle digest Waffle binds project trust to (`id@sha256`): SHA-256 of the canonical JSON of `[manifest, files]` over the `.js`, `.json` and `.wasm` files without the manifest, as **Add to project** computes it. Checked after unpacking when present. |
| `source` | no | `https://` address of the source code. |
| `description`, `license` | no | Shown in the Browse view (`license` as an SPDX identifier). |
| `signature` | no | Reserved: `null`, or an object such as `{"alg": "ed25519", "keyId": "…", "value": "…"}`. It is shown as "present, not verified" until signing is implemented. |

Compared with Open VSX, the index is a single static file rather than an API, an entry is one version of one extension, and the permissions are part of the listing so users can judge an extension before downloading it.

## Publishing guide

1. **Build the package.** Zip your extension folder (the one holding `waffle-extension.json`), or write a `.waffle-extension` bundle. Check it with **Install from package…** in Waffle first.
2. **Make the entry.** `scripts/registry-entry.py` reads the manifest from the package and prints the entry with its SHA-256 and size:

   ```sh
   python3 scripts/registry-entry.py my-ext-1.0.0.zip --download packages/my-ext-1.0.0.zip \
       --source https://github.com/me/my-ext --license MIT
   ```

3. **Publish.** Put the package where `download` points and add the entry to the index's `extensions` list. Never replace a published package in place: publish a new version with a new entry. A changed file no longer matches its `sha256`, and Waffle refuses it.
4. **Describe the permissions.** The README should list each permission and why it is needed, and for each `network:` host, what is sent there.
5. **Follow the project policies.** MIT or Apache-2.0 is recommended. No third-party vendor code, libraries, logos or documentation text (see the clean-room policy in [CONTRIBUTING.md](../CONTRIBUTING.md)).

To try an index locally, serve the folder with `python3 -m http.server 8000` and set the registry URL to `http://localhost:8000/index.json`, or use **Open index file…**.

## Security model

The registry adds discovery. It adds no new trust in code: the extension sandbox and the permission prompt remain the security boundary, and a registry install ends in exactly the same state as installing the same package from disk.

| Threat | Defence |
| --- | --- |
| Waffle contacting a server the user did not choose | Off by default; no request until a registry URL is saved; only that index and the packages the user installs are fetched (`tests/extension-registry.cjs` records every request). |
| A tampered or substituted package (compromised host, mirror, or network) | The package's SHA-256 is computed in the editor and compared with the index **before the package is parsed**. Any mismatch, or a size other than `size`, is refused and nothing is installed or prompted. |
| A package that asks for more than the listing showed | The manifest's `id`, `version` and `permissions` must equal the entry's. Otherwise nothing is installed. |
| Permissions hidden until after download | The Browse view lists every requested permission from the index; installing then shows Waffle's own permission prompt again, from the verified manifest. Declining installs nothing. |
| Credential or tracking leaks | Requests use `credentials: "omit"`, `referrerPolicy: "no-referrer"` and `cache: "no-store"`. URLs with user info are refused. The index request does not follow redirects. |
| Downgrade or plain-text interception | `https://` only, except to this computer. |
| Oversized or malformed input | The index is capped at 4 MB and 5,000 entries and validated field by field; packages at 32 MB (checked against `Content-Length` and while streaming), then the usual ZIP limits of the extension installer. |
| Code from the registry escaping the sandbox | Unchanged: every extension runs in its own worker inside the sandboxed iframe with CSP `default-src 'none'`, with capability checks on every call ([extensions/README.md](../extensions/README.md#threat-model)). |

**What the SHA-256 does not prove.** It proves the package is the one the index lists, not who wrote the index. Whoever controls the index controls which packages it lists, so only add registries you trust, as with any package source. Publisher signatures (below) are meant to close this gap.

Where the installed package came from (index URL, version, digest and source) is kept locally and shown in the Browse view as "Installed from".

## Planned

- **Publisher signatures.** Ed25519 over the package digest, id and version, with key history in `keys/<publisher>.json` and rotations signed by the previous key. Waffle would show "Signed by acme (key …)" and warn loudly when the key changes. The `signature` field is reserved for this.
- **A signed index and revocation.** `index.json` and a `revoked.json` (bundle hashes and keys) signed by a registry key pinned in Waffle, so mirrors can serve but not alter them. A revoked extension would be disabled and shown as *Revoked*, never deleted silently. Who holds the key follows [GOVERNANCE.md](../GOVERNANCE.md).
- **Updates.** An update with the same permissions after a one-line notice; any new permission (a `network:` host in particular) shows the full prompt, as `install` already does. Auto-update off by default.
- **Review levels** for a community registry repository:

  | Level | Meaning | Gate |
  | --- | --- | --- |
  | Listed | Automated checks passed | Manifest valid; package under 32 MB; licence present; no minified code without its source; `id` matches the publisher namespace |
  | Reviewed | A maintainer or trusted reviewer read the code | Required for any `network:` or `write:edits` permission |
  | Built-in | Ships with Waffle | Same review, plus tests in `tests/` |

  CI on the registry repository would diff permissions against the previous version and flag additions for human review. Malware or a policy breach would lead to revocation within 24 hours of confirmation, with appeals under GOVERNANCE.md.
- **Command line.** Installing from an index for headless `run_script` and CI.

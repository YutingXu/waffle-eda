# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately:

- **Email:** [yuting.xu@imperial.ac.uk](mailto:yuting.xu@imperial.ac.uk), with "Waffle security" in the subject.
- **Or GitHub:** [Report a vulnerability](https://github.com/YutingXu/waffle-eda/security/advisories/new) (repository → *Security* → *Report a vulnerability*). Only the maintainers can see the report.

Include:

- the Waffle version or commit, the OS, and the host (macOS app, Windows app, Linux app, browser or MCP server);
- the steps or a minimal proof-of-concept project, extension or MCP call;
- the impact: what an attacker gains and what the victim must do (open a project, install an extension, run an MCP tool).

## What happens next

| Step | Target time |
| --- | --- |
| Acknowledge the report | 3 working days |
| Initial assessment and severity | 10 working days |
| Fix or mitigation for High/Critical | 30 days, sooner where possible |
| Coordinated public disclosure | After a fixed release, or 90 days after the report, whichever is first, unless we agree otherwise |

We credit reporters in the advisory and release notes unless they ask us not to. There is no paid bug bounty.

## Scope

In scope:

- **Untrusted project files** (`.waffle`, imported Altium®, KiCad, Eagle or EasyEDA files) that cause code execution, sandbox escape, file writes outside the expected paths, or denial of service beyond the documented budgets.
- **The extension sandbox**: escaping the Worker or iframe, using permissions that were not granted, network access without a `network:` grant, impersonating another extension, or bypassing the trust digest.
- **The MCP server and CLI**: writing outside `<project>-outputs/` or the project, writing without `--allow-write`, escaping the `run_script` sandbox, or path traversal.
- **Native hosts** (`native/macos`, `native/linux`, `native/windows`): bridge calls reachable from content they should not be reachable from.
- **Secrets**: API keys reaching a project file, log, export or settings bundle.

Out of scope:

- An extension the user explicitly granted `write:edits` making bad but undoable edits, or a `network:` host the user allowed receiving what the extension sends it. Both are documented limits.
- Manufacturing correctness (wrong Gerber output, for example). Please file a normal bug.
- Vulnerabilities in the system webview or OS. Report those to the vendor.

## Supported versions

Security fixes go to the latest release and the main branch. Older 0.x releases are not patched.

## Security design

- Threat model: [extensions/README.md](extensions/README.md#threat-model).
- Extension permissions and host grants: [Extension API](docs/extension-api.md#permissions).
- MCP write safety: [mcp/README.md](mcp/README.md#writing-in-place).

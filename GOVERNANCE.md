# Governance

Waffle EDA is an MIT-licensed open-source project. This document describes how it is run today. It will change as the community grows, and changes to it go through the same pull-request process as code.

## Roles

- **Users** use Waffle, report bugs, request features and file parity gaps.
- **Contributors** send pull requests, reviews, documentation, extensions, templates or test fixtures. Every contribution is under the MIT License and must follow the clean-room policy in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Maintainers** have merge rights. They triage issues, review pull requests, cut releases and hold the release and (future) registry signing keys. The current maintainers are listed in `MAINTAINERS` _(maintainer: create this file)_.
- **Lead maintainer** breaks ties and is the final escalation point while the project is small.

A contributor becomes a maintainer after a sustained record of good contributions and reviews, on the nomination of a maintainer and with no objection from the other maintainers within a week. Maintainers who are inactive for six months move to emeritus status and can return on request.

## Decisions

- **Day to day:** lazy consensus on pull requests. One maintainer approval is enough for most changes. Two are needed for security-sensitive changes to the extension host and worker, edit proposals, the public API, MCP or the native hosts.
- **Larger changes** (file format, API versions, new permissions, registry policy, licence questions) start as an issue labelled `rfc` and stay open for at least seven days. If consensus is unclear, the maintainers vote by simple majority, and the lead maintainer breaks ties.
- **Priorities** are discussed in the [issue tracker](../../issues). The project values a lightweight desktop editor, AI through MCP, a customisable interface and an open community.

## Principles that need an RFC to change

1. Waffle stays offline-first: no account, no telemetry, and no network use without an explicit user opt-in.
2. Untrusted projects and extensions never run code without user consent bound to the exact bytes.
3. AI and automation edit through reviewable proposals by default.
4. Interoperability is clean-room, and other companies' marks are used only descriptively.
5. Startup and memory budgets (`scripts/startup-budget.sh`, `scripts/perf-canvas.sh`) are only raised with measurements and a reason.

## Conduct and security

Everyone in project spaces follows the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues follow [SECURITY.md](SECURITY.md), not public issues. Moderation decisions can be appealed to a maintainer who was not involved.

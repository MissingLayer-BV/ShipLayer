# ShipLayer

[![check](https://github.com/MissingLayer-BV/ShipLayer/actions/workflows/check.yml/badge.svg)](https://github.com/MissingLayer-BV/ShipLayer/actions/workflows/check.yml)

**From repo to review.** ShipLayer is a local-first, safety-first release CLI for App Store Connect. It scans your native app repository, captures evidence instead of guessing, and generates the assets and checklists between a build and App Review.

> Status: v0.1 beta. The happy path works end to end, but final App Review submission stays human-controlled by design, and several declarations still need your explicit confirmation. See [docs/automation-boundaries.md](docs/automation-boundaries.md) for what ShipLayer will and won't do.

## Why

Shipping a mobile release means dozens of small, high-stakes facts spread across Xcode project files, Swift sources, store listings, privacy answers, screenshots, and review notes. ShipLayer collects the machine-checkable parts into one deterministic flow, blocks on anything it cannot prove, and hands the rest to you as explicit questions — so nothing reaches the store by accident.

- **Evidence, not guesses.** Every finding cites its source file. Heuristics are proposals; privacy, legal, pricing, and review facts require your confirmation.
- **Safe by default.** Planning is read-only. Writes need three independent gates (clean preflight, `sync.mode: apply`, explicit flags) and submission never happens from the CLI.
- **Agent-friendly.** Ships a `ship-app-store` skill so a coding agent can run the whole flow without improvising release logic.

## How it works

v0.1 is distributed as a git checkout, not an npm package (`private: true`) — clone, build, and run from `./dist/index.js`, or `npm link` it onto PATH.

```bash
npm ci && npm run build
./dist/index.js analyze /path/to/MySwiftApp  # read-only scan
./dist/index.js init /path/to/MySwiftApp     # draft shiplayer.yml (incomplete on purpose)
# answer the questions it asks you, then:
./dist/index.js prepare /path/to/MySwiftApp  # generate shiplayer-release/
./dist/index.js check /path/to/MySwiftApp    # preflight; exit 2 while blockers remain
./dist/index.js plan /path/to/MySwiftApp --remote  # read-only App Store diff
```

`prepare` writes a managed `shiplayer-release/` package: normalized manifest, reports, per-locale metadata drafts, privacy/support/legal drafts, review notes, screenshot harness template and capture workflow, marketing screenshot project, StoreKit checklist, and remaining human actions. Review it, then — only on your explicit go-ahead — `apply` writes the reviewed change set to the store. `submit` stays a manual handoff.

| Step | Command | Effect |
|---|---|---|
| Discover | `analyze <repo>` | Read-only scan with evidence and open questions |
| Declare | `init <repo>` | Draft `shiplayer.yml`; never overwrites without `--force` |
| Generate | `prepare <repo>` | Local release package only; no uploads |
| Gate | `check <repo>` | Preflight; exit 2 while blockers remain |
| Preview | `plan <repo> [--remote]` | Offline plan, or read-only store diff |
| Capture | `capture <repo>` | Screenshot harness hand-off and PNG ingestion |
| Write | `apply <repo>` | Preview by default; writes only fully gated |
| Finish | `submit <repo>` | Manual handoff; v0.1 never submits |

## The three pieces

- **CLI** (`./dist/index.js`) — the engine. Every scan, check, diff, and write happens here.
- **Agent skill** (`skills/ship-app-store`) — teaches a coding agent to drive the CLI; it invents no release logic itself.
- **Composite Action** (`action.yml`) — runs `plan`/`apply` in your workflows, including screenshot rendering. Stays read-only unless you dispatch `apply` from a protected environment.

Screenshots and CI: raw app-pixel capture never runs in CI — it needs your reviewed UI-test harness on macOS/Xcode (ShipLayer hands you the workflow, you press run, then `capture --from` ingests). What CI *can* do is render the marketing decks from existing raws (`render-screenshots: "true"`) before planning or applying.

## Install the agent skill

```bash
npm run install-skill      # build + npm link + symlink the skill
command -v shiplayer       # verify
```

This links the CLI onto PATH and symlinks `skills/ship-app-store` into the skill directories agent tools read (`~/.claude/skills/`, `~/.codex/skills/`). Idempotent; `npm run install-status` checks, `npm run uninstall-skill` removes only what it created.

## Docs

- [docs/architecture.md](docs/architecture.md) — pipeline and components
- [docs/automation-boundaries.md](docs/automation-boundaries.md) — what v0.1 will and won't automate
- [docs/safety-model.md](docs/safety-model.md) — credentials, triple-gate writes, manual remainder
- [docs/manifest-gates.md](docs/manifest-gates.md) — permission flows, contradiction blockers, copy rules
- [docs/screenshots.md](docs/screenshots.md) — harness, capture, marketing composition
- [docs/asc-apply.md](docs/asc-apply.md) — App Store Connect apply flow and CI action
- [skills/ship-app-store](skills/ship-app-store) — the agent skill itself

## Development

Requires Node 22+.

```bash
npm install
make check
```

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs `npm run check` (lint + 419 tests + build) on every push and PR.

## License

MIT — see [LICENSE](LICENSE).

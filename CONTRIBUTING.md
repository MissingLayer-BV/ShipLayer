# Contributing

## Setup

Requires Node 22+.

```bash
npm ci
npm run check   # lint + tests + build
```

## Ground rules

- `shiplayer.yml` and generated packages must never contain credentials, `.p8`
  contents, tokens, or passwords. See `src/secrets.ts` and `SECURITY.md`.
- Heuristics are proposals: anything the scanner detects but cannot prove
  stays `needs-human-confirmation`. Never auto-confirm privacy, legal, or
  monetization facts.
- Remote planning stays GET-only. Writes keep the triple gate
  (blocker-free preflight, `sync.mode: apply`, explicit CLI flags).
- Add or update tests in `test/` for every behavior change
  (`npm test` runs them via `tsx --test`).
- Keep the README short. Deep detail belongs in `docs/`; link to it instead
  of expanding the README.

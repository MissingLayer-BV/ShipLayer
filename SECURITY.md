# Security

ShipLayer handles App Store Connect credentials (ES256 private keys).
If you find a vulnerability — especially credential
leakage into manifests, generated packages, logs, or terminal output — please
report it responsibly.

- Do not open a public issue for credential-handling bugs. Contact the
  maintainers privately (see the repository profile for contact details).
- Do not include real `.p8` contents, tokens, passwords, or banking details in
  any report, fixture, or reproduction. Use redacted placeholders.
- ShipLayer's defense-in-depth rules (`src/secrets.ts`, manifest validation,
  `emit` secret-scanning in `src/generator.ts`) exist precisely because this
  tooling sits close to secrets; please verify them against the code, not just
  the docs.

For non-sensitive bugs, open a regular GitHub issue.

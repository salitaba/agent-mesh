# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately, by either of:

- GitHub's private vulnerability reporting: <https://github.com/salitaba/agent-mesh/security/advisories/new>
- Email: ali79taba@gmail.com

Include what you found, how to reproduce it (a request, a config, a version), what an attacker gains, and
whether you have told anyone else.

## What to expect

These are the targets this project commits to; they are deliberately ones a small team can keep.

| Step | Target |
|---|---|
| We acknowledge your report | within 3 business days |
| We tell you whether we think it is a vulnerability, and how serious | within 10 business days |
| A fix, or a mitigation and a date, for a high or critical issue | within 30 days |
| Public disclosure | after a fix is available, coordinated with you; we credit you unless you prefer not |

## Supported versions

Security fixes go into the latest release. Until there is a release cadence worth stating, assume older
releases are not patched: upgrade (see `docs/operations.md`).

## Scope

In scope: the runtime and its packages, the HTTP server and the multi-project host, the CLI, the dashboard, the
container image, the Helm chart and Compose file, and the licence verification.

Not in scope, and where to take it instead:

- **The Claude Code binary and Anthropic's services.** Report to Anthropic: <https://hackerone.com/4f1f16ba-10d3-4d09-9ecc-c721aad90f24/embedded_submissions/new>.
- **Third-party dependencies.** Report upstream, and tell us so we can update.
- **Things the documentation already says are not protected**, such as agents running inside the container being
  able to use what the container can reach, or one instance not isolating its projects from each other
  (`docs/commercial/security.md`, "What it does not do"). A way to make those *worse than documented* is in scope.
- Findings that need an operator's own credentials to be used against that operator, denial of service by
  someone who already has the operator token, and social engineering.

## Good-faith research

If you make a good-faith effort to follow this policy, test only instances you own or have permission to test, avoid
reading or changing anyone else's data, and give us reasonable time to fix a problem before you disclose it, we will
not pursue legal action against you for it, and we will work with you to understand and resolve it.

## How we handle one

A report is tracked privately, reproduced with a test that fails before the fix, fixed with that test, and released
with an advisory that names the versions affected, the fix and any mitigation. See `docs/commercial/security.md` for
the controls the existing tests pin.

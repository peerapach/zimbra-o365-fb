# Zimbra ↔ Microsoft 365 Free/Busy Gateway

A query-only gateway for native free/busy lookups between Zimbra 10.1.18 OSS and Microsoft 365. It does not write calendars, synchronize events, copy mailboxes, publish calendar links, or add a scheduling UI. Microsoft 365 availability is read through Microsoft Graph; the gateway never calls Exchange Online EWS.

## Start here

Follow the [zero-to-production operator guide](docs/PRODUCTION_SETUP.md) in order. It covers inventory, the two-host deployment, scoped permissions, configuration and secrets, a two-way native-client pilot, release checks, and rollback. [Deployment details](docs/DEPLOYMENT.md), the [administrator runbook](docs/ADMIN_RUNBOOK.md), [operations](docs/OPERATIONS.md), [security](docs/SECURITY.md), and [architecture](docs/ARCHITECTURE.md) are supporting references.

The code has passed fixture/mock-based offline checks, **not** a live Microsoft 365 tenant, the installed Zimbra OSS build, native scheduling clients, or production image/host tests. The operator guide contains mandatory stop conditions; following it cannot guarantee compatibility where a real client or tenant has not yet been tested. Do not enable production traffic until the pilot and release gates pass.

## Offline verification

Use Node.js `24.21.0` and npm `11.19.0` ([dependency pins](docs/DEPENDENCY_LOCK.md)):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

This runs lint, typecheck, unit, contract, integration, and security tests, then builds the application. GitHub Actions runs the same offline checks. Neither result proves live interoperability or authorizes a production change.

## Deployment inputs

The [Dockerfile](Dockerfile) and [two-host Compose template](deploy/compose.yaml) require an approved image digest, reviewed configuration bundle, and file-backed secrets. [Example configuration](config/example.json) and [environment example](.env.example) contain placeholders, not deployable production values. Keep all credentials, private keys, tenant captures, and production configuration outside Git.

Unknown, denied, malformed, or timed-out availability is never reported as free. Only authorized administrators may change tenant, DNS, mail routing, Zimbra, or production infrastructure settings.

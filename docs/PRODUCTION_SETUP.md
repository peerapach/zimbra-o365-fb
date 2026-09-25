# Zero-to-production operator guide

This is the ordered path for an **authorized infrastructure, Microsoft 365, Zimbra, and service-owner team**. It starts with read-only inventory and ends with a controlled release decision. Commands that inspect the repository can be run by the operator; tenant, routing, credential, and production-host changes require the organization's change approval. Never put real secrets, raw calendar data, or client captures in Git, CI logs, tickets, or chat.

**Current evidence boundary:** the gateway has fixture/mock test coverage, but no live tenant, installed Zimbra 10.1.18 OSS driver, native client, Docker image, Nginx proxy, or production host has been proven by this repository. A green offline test is not permission to skip a gate below. If any **Stop** condition occurs, do not route production traffic; record the sanitized result and make a separately reviewed correction.

## 0. Assign owners and record the deployment worksheet

Record the following in restricted organizational storage, not in this repository. Use one approved pilot identity on each side before expanding scope.

| Owner | Values to determine and approve |
|---|---|
| Service owner | Pilot users, allowed free/busy disclosure, change window, acceptance criteria, rollback owner, ongoing support owner |
| Microsoft 365 administrator | Tenant/cloud, Exchange Online availability configuration, pilot alias/domain and recipient, Graph app/client ID, scoped mailbox set, inbound integration username |
| Zimbra administrator | Exact OSS build and installed free/busy provider, private SOAP URL, dedicated non-admin free/busy service account, inbound integration username |
| Infrastructure/security | Two Linux hosts in separate failure domains, registry image digest, public/private/management DNS and IPs, TLS/mTLS identities, existing HA load balancer, firewall/egress rules, secret-store paths, scanner and monitoring |

**Pass:** each value has an owner, a restricted record, and a rollback plan. **Stop:** an owner, approved pilot scope, or independent release reviewer is missing. See [architecture](ARCHITECTURE.md) and [security boundaries](SECURITY.md).

## 1. Prove the integration is feasible before changing production routing

1. On Zimbra, an administrator records `zmcontrol -v`, installed package/build provenance, available free/busy providers (`zmprov gafbp` where supported by that build), and the effective global/domain/COS/account settings for the pilot requester. Use local help to verify command syntax; do not dump password-bearing global configuration into evidence. The [published Zimbra v10 administration guide](https://zimbra.github.io/documentation/zimbra-10/adminguide.html) describes the `ews` provider but is a Network Edition guide, **not proof for this OSS installation**.
2. In an authenticated Exchange Online PowerShell session, record the current state privately before any change:

   ```powershell
   Get-AvailabilityConfig | Format-List
   Get-AvailabilityAddressSpace | Format-List ForestName,AccessMethod,TargetAutodiscoverEpr,TargetServiceEpr,TargetTenantId
   ```

   Inspect the pilot recipient, accepted domain, and mail-routing path as well. If an Availability Address Space or recipient already serves another integration, do not replace it blindly. The [Microsoft cmdlet reference](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/add-availabilityaddressspace?view=exchange-ps) documents `OrgWideFB` and `TargetAutodiscoverEpr`, but also marks `OrgWideFB` deprecated for accessing target forests in Exchange Online. Confirm that the proposed external route is accepted and works in this tenant.
3. Confirm that the organization accepts the current [Exchange Online EWS retirement timeline](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online) and the residual risk for a custom external availability path. This gateway does not call Exchange Online EWS, but that fact alone does not certify Microsoft's native callback behavior.
4. Confirm that both native clients can use the proposed Basic-over-TLS integration credentials, SOAP/POX profile, and TLS path. The current binary emits a fixed **candidate** Autodiscover response and accepts a narrow EWS profile. It does not become a general EWS server after deployment.

**Pass:** the actual OSS build, tenant configuration, and pilot client path are identified, and the service owner accepts the supported scope. **Stop:** the installed provider is absent, the tenant rejects the external availability route, the caller requires unsupported authentication/operations, or another integration would be disrupted. Do not substitute anonymous access, public calendars, cloud EWS calls, or a fake success response. Use the [administrator runbook](ADMIN_RUNBOOK.md) for guarded pilot configuration.

## 2. Verify the source and build a candidate image

Use the pinned [Node.js/npm versions](DEPENDENCY_LOCK.md) and the reviewed source commit:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
docker build --tag freebusy-gateway:local-review .
```

The GitHub workflow runs the offline code checks only. An approved build environment must also inspect the actual image and all layers, generate an SBOM, scan it with the organization's approved scanner and current advisory data, and verify the final process is non-root with only production dependencies. Record source/lock hashes, platform, scanner identity, findings, and image digest. Do **not** build on a production host or promote a mutable tag. See [deployment details](DEPLOYMENT.md).

**Pass:** offline checks, image build, content inspection, SBOM and scan all meet the organization's release policy. **Stop:** any check fails or the scanner/build platform is unavailable. This repository has not run Docker locally.

## 3. Prepare narrowly scoped provider access and pilot recipients

1. The Microsoft 365 administrator creates or reviews a dedicated certificate-based Graph application, the corresponding Exchange service-principal pointer, and an application RBAC scope restricted to pilot mailboxes. Verify both an allowed and a denied mailbox with `Test-ServicePrincipalAuthorization` **and real `getSchedule` requests**. A broad separate Entra grant can defeat the RBAC scope; review effective permissions. The [Exchange application RBAC guide](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) explains this additive behavior. Do not grant `Calendars.ReadWrite` or tenant-wide calendar access to make a test pass.
2. The Zimbra administrator provisions a normal dedicated service account with only approved free/busy visibility for pilot targets. Prove allowed, denied, nonexistent, empty and private-event behavior against the installed SOAP endpoint; never make all calendars public.
3. The Microsoft 365 administrator drafts a narrow pilot availability alias/contact and an `OrgWideFB` entry after reviewing the existing `AvailabilityConfig`. Do not create recipients or activate the new route yet; the guarded example in [ADMIN_RUNBOOK.md](ADMIN_RUNBOOK.md) is for the later pilot cutover. Do not route a whole shared domain to this gateway.
4. The Zimbra administrator records the exact requester/global/domain/COS/account setting that would point the installed EWS free/busy provider, if present, to the **private** gateway origin using its own inbound credential. Do not change the active provider route yet. Do not interpret an admin-console `GetFolder` connection test as the free/busy acceptance test.

**Pass:** each integration has its own identity, least-privilege proof and an approved, reversible pilot-route plan; existing invitation delivery is unchanged. **Stop:** any denied target returns availability, an identity has excess privilege, or the proposed native route cannot be isolated to the pilot. Tenant and Zimbra mutations are administrator-owned, never performed by this guide automatically.

## 4. Prepare two hosts, three ingress surfaces, and network policy

Deploy one gateway container and one locally managed TLS proxy on **each** of two dedicated Linux hosts. Use the organization's existing highly available load balancer with separate pools:

| Surface | Example gateway loopback | Upstream access |
|---|---|---|
| Microsoft-facing public EWS/Autodiscover | `127.0.0.1:8080` | Only approved public LB frontend via host TLS proxy |
| Zimbra-facing private EWS | `127.0.0.1:8081` | Only approved private Zimbra/LB frontend via host TLS proxy |
| Health and metrics | `127.0.0.1:8082` | Only management/monitoring identities |

Replace every documentation IP, hostname, certificate path and CA in [the Nginx example](../deploy/lb.example.conf) with reviewed per-host values. Validate the rendered configuration with `nginx -t` before routing traffic. Verify trusted TLS certificates and hostnames; the LB-to-proxy hop uses the approved mTLS identity, while native clients are not forced to present one. Block remote access to gateway loopback ports and management paths from both user-facing networks. Allow outbound only to approved Microsoft login/Graph endpoints, the fixed private Zimbra SOAP endpoint, and necessary DNS. Never disable TLS validation.
Synchronize both hosts to the organization's approved time source; token and certificate validation depend on accurate time.

**Pass:** public and private callers cannot reach each other's route or management, and only the intended LB/monitor sources reach each proxy. **Stop:** a single host/proxy is the only failure domain, a listener is remotely exposed, TLS validation fails, or a header/redirect can change the backend destination.

## 5. Materialize reviewed configuration and secrets outside Git

Create a versioned, read-only bundle on each host, mounted as `/etc/freebusy`, containing `gateway.json`, `directory.json`, `limits.json`, and `protocol-profiles.json`. Start from [the JSON examples](../config/example.json) and [the pinned limits](../contracts/limits.json), but **do not deploy an example unchanged**. In `gateway.json`:

- Set `environment` to `production` and `liveAccessEnabled` to `true`; keep the three loopback binds/ports matched to the proxy. Set `public.advertisedOrigin` to the approved public HTTPS origin ending in `/`.
- Set the real public-cloud tenant/client UUIDs, fixed `https://graph.microsoft.com/v1.0` base URL, private Zimbra `https://.../service/soap` URL, and normal Zimbra service account. Production rejects `.invalid` hosts and placeholder IDs.
- Set `directoryFile`, `limitsFile`, and `protocolProfilesFile` to filenames relative to `/etc/freebusy` (for example `directory.json`, `limits.json`, `protocol-profiles.json`), not to the repository's `config/` paths. Map only opted-in pilot identities and aliases; the Microsoft-facing principal may reach only Zimbra entries, and the Zimbra-facing principal only Graph entries.
- Keep every `limits.json` value consistent with the shipped [limits contract](../contracts/limits.json). The runtime rejects changed limits. A mapping in JSON does not create a Microsoft recipient or grant calendar access by itself.

The four file-backed secrets in [Compose](../deploy/compose.yaml) are a combined Graph certificate **and matching private key** (`graph-certificate.pem`), a non-admin Zimbra password without trailing newline (`zimbra-password`), and two distinct inbound Basic password-digest files (`exo-interop`, `zimbra-interop`). Each digest file contains one or two lowercase SHA-256 hex digests of the **password bytes only**, one per line; the plaintext password is held by the corresponding integration owner, not in the mounted file. Inbound passwords must be high entropy and 32–512 bytes. Materialize all four as direct regular files, owned by container UID 1000, mode 0400 or 0600, with no symlink/hard-link path; keep parent directories traversable for that UID and inaccessible to unapproved users. Never place secret values in Compose environment variables or a shell command line.

The shipped protocol profile is deliberately `candidate-not-live-verified` with `productionApproved: false`. The current binary accepts only this candidate shape; changing that field to `true` will not approve the profile—it prevents startup. Treat approval as an external release decision until a separately reviewed code/profile change exists. The legacy EWS timezone candidate signatures are bounded to 2026; requests outside that horizon may fail closed. Test the exact native client profile and required calendar date horizon before release.

**Pass:** reviewed files are immutable/versioned, secret ownership and paths pass metadata checks, and the candidate starts without using fake providers. **Stop:** a required live profile differs, future-date legacy requests are needed but unsupported, any secret is readable by an unapproved account, or startup validation fails. Do not weaken the validator to bypass a failed gate.

## 6. Render Compose and deploy to an isolated pilot path

Provision the four non-secret Compose variables through an approved environment file **outside Git**: `FREEBUSY_IMAGE` (registry reference with `@sha256:` digest), `FREEBUSY_CONFIG_DIR` (absolute config-bundle directory), `FREEBUSY_SECRETS_DIR` (absolute secret-store materialization directory), and `FREEBUSY_INGRESS_APPROVED=public+private` **only after** Step 4 has passed. `FREEBUSY_CONFIG` is set inside the template to `/etc/freebusy/gateway.json`. Do not put secret contents in this file.

On each host, from a copy of the reviewed source/template and with the approved environment file:

```sh
docker compose --env-file /absolute/approved/compose.env -f deploy/compose.yaml config --quiet
docker compose --env-file /absolute/approved/compose.env -f deploy/compose.yaml pull
docker compose --env-file /absolute/approved/compose.env -f deploy/compose.yaml up -d --no-build
docker compose --env-file /absolute/approved/compose.env -f deploy/compose.yaml ps
```

Use a registry digest from the approved image, not `freebusy-gateway:local-review`. On the host, `curl --fail --silent http://127.0.0.1:8082/readyz` may be used as a **local** readiness check; it does not test TLS, provider permissions, or native client display. Check the proxy and LB routes separately. Do not put both replicas on one VM and call it HA.

**Pass:** both isolated pilot instances are healthy, their approved image/config/secret tuple is recorded, and negative route/auth tests reject cross-surface calls. **Stop:** Compose validation, secret mounts, startup, health, proxy or network isolation fails. Keep production LB pools disabled. Only then, during the approved pilot change window, the administrators activate the **pilot-only** LB/frontend and the specific recipient/AAS/Zimbra routes prepared in Step 3. Confirm invitation delivery immediately and keep the exact pre-change settings ready for rollback. If either pilot route fails, restore those settings and disable the pilot frontend before proceeding.

## 7. Perform the native two-way pilot and decide go/no-go

The service owner creates **synthetic** free, tentative, busy, out-of-office and private appointments in the two pilot calendars. From the native Zimbra scheduling view, query an opted-in Microsoft 365 user through the private gateway. From the native Microsoft 365 scheduling view, query an opted-in Zimbra user through the public Autodiscover/EWS path. Record sanitized request profile, status/timeline, client display and timestamps in restricted storage.

Test both directions with aliases, multiple/duplicate attendees, denied and nonexistent targets, empty calendars, timezone/DST and a date beyond 2026 if the client sends legacy EWS timezone data. A private event title/location must never appear in responses, logs or metrics. Deliberately break one backend to confirm the client sees unknown/failure, **not free**. Verify invitations still route normally and that the gateway makes no Exchange Online EWS outbound request. Test Graph allowed and denied recipients through the real API, not only an RBAC simulation.

**Pass:** both native UIs show the expected availability, every negative/privacy case remains safe, required date ranges work, and the service owner signs the captured client/protocol profile. **Stop:** API-only success without native display, an unsupported request shape, wrong timezone, permission leak, fake-free result, mail-delivery regression, or unresolved post-retirement support risk. The present repository has no such live evidence; no one should mark this step passed from fixtures.

## 8. Promote, observe, and retain a rollback tuple

Only after independent security/release review, promote the **same immutable digest** that passed Step 2 and the pilot. Record source commit, image digest/platform, config and protocol/limits hashes, secret generation IDs (never values), proxy/LB/firewall revision, approvals, monitoring thresholds and the pre-change routing baseline. For later upgrades, also record the previous known-good gateway tuple. Drain one host from **both** LB pools, deploy the reviewed tuple, recheck local health and native synthetics, then re-enable it. Repeat on the second host only after observation. See the detailed [deployment rollback sequence](DEPLOYMENT.md) and [operations runbook](OPERATIONS.md).

Monitor per-surface errors, unknown results, backend latency/throttling, certificate expiry, native synthetics, mail delivery and host health. A `200` readiness response does not mean either provider is healthy. On a first-release regression, disable the new LB route and have the administrators restore only the newly changed AAS/recipient/Zimbra settings from the captured baseline; leave the new native lookup disabled until corrected. On a later upgrade, drain the affected host and restore the previous compatible image/config/proxy/secret tuple, plus only the specifically changed tenant/Zimbra routing objects if necessary. Gateway cache is disposable; calendar events are not stored here.

**Production go/no-go:** the service owner, Zimbra and Microsoft 365 administrators, infrastructure/security reviewer and operations owner must all accept the recorded live evidence and residual vendor/protocol risk. If any owner cannot approve, remain on the pilot path. Retest after a Zimbra patch, tenant policy change, client upgrade, credential rotation or Microsoft availability-policy change.

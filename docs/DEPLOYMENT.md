# Candidate two-host deployment

The repository supplies candidate definitions, not a deployed or scanned image.
Image build/content inspection, vulnerability scan, `docker compose config`,
`nginx -t`, restart/drain and real network isolation checks require an approved
infrastructure environment before promotion. Tenant/native-client compatibility,
permissions and operational acceptance also require separate live evidence.
Mock success never proves native-client compatibility or tenant permissions.

The root Dockerfile defines the gateway image. It installs no global developer tools.

## Topology and trust boundary

Use two dedicated Linux hosts in separate failure domains, each with one gateway
container and an organization-managed local TLS proxy. The existing enterprise
HA LB owns independent public Microsoft and private Zimbra frontends/pools. Two
containers on one VM are not host HA. Do not add a single shared proxy as a new
single point of failure. Configure host time synchronization.

| Flow on each host | Per-host proxy socket (illustrative only) | Gateway socket |
|---|---|---|
| Microsoft-facing LB → EWS/POX | 192.0.2.10:8443, TLS + LB identity | 127.0.0.1:8080 |
| Private Zimbra LB → EWS only | 198.51.100.10:8444, TLS + LB identity | 127.0.0.1:8081 |
| LB health / approved monitoring | 203.0.113.10:9443, separate management VLAN | 127.0.0.1:8082 |

All IPs/domains in `deploy/lb.example.conf` are documentation placeholders. Host B
has different addresses/certificates. Replace them privately under review; do not
make this example a wildcard listener. Management is never routed from either
user-facing frontend; only LB management identities can GET `/readyz`, and only
the approved monitoring identity can GET `/healthz` or `/metrics`.

The validator permits only loopback binds. Therefore this template deliberately
uses Linux `network_mode: host`, **without `ports`, `expose` or bridge networking**.
The same-host proxy can reach loopback; Docker bridge publishing cannot reach a
loopback-only process inside another network namespace. This expands container
access to host-local services, so use dedicated hosts, no untrusted local users or
workloads, and reviewed host firewall/cgroup egress policy. Do not use privileged
mode, host PID namespace or a Docker socket mount. Rootless/Desktop networking is
not validated by this template. [Docker networking reference](https://docs.docker.com/reference/compose-file/services/#network_mode).

Before setting ingress approval, administrators must prove:

- Native clients use approved Basic-over-TLS without interactive login/mTLS changes.
  TLS is verified again between HA LB and local proxy; the example requires mTLS
  only for that internal hop and the management clients. Use a dedicated issuing
  CA and authorized LB/monitor identities, not a broad employee certificate CA.
- Firewall source allowlists restrict each proxy interface to its designated LB
  or monitoring addresses. Block direct remote 8080/8081/8082, cross-VLAN routes
  and all management access from public/private caller networks.
- Outbound policy permits only approved DNS and HTTPS Graph/OAuth plus the fixed
  Zimbra user SOAP endpoint, never cloud EWS/admin SOAP/public ICS. TLS hostname
  and certificate validation stay enabled. Any corporate CA must be separately
  mounted/reviewed; never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- LB/proxy preserve Authorization and SOAPAction unchanged, with no request/response
  body logging, access logging, caching, fallback success, redirects or replay of
  POST to another host. Unknown/error remains Unknown/error.
- LB enforces total header/body receive limits (5 seconds), 256 KiB body and 16 KiB
  headers, source admission limits and connection bounds. Proxy read timeout is
  10 seconds and LB response budget at least 12 seconds, above the application's
  8-second work budget. Idle timeouts alone do not bound a trickling sender.

The standalone Nginx example proxies only exact paths to fixed loopback sockets;
it disables buffering/retry/cache and propagates disconnects. Forwarded identity
headers are stripped. The gateway does not trust X-Forwarded-For, so its pre-auth
source bucket sees local proxy traffic in aggregate; enforce per-source controls
at the HA LB and validate aggregate pilot rate limits without silently widening
the contract. [Nginx proxy reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

## Image, configuration and secrets

The Dockerfile uses the immutable Node24 index recorded in DEPENDENCY_LOCK.md,
`npm ci` in separate build/production-dependency stages and only production
dependencies in the final stage. A deny-by-default `.dockerignore` admits selected
TypeScript build inputs but excludes the scaffold, tests, fixtures, deployment
files, private env files and tools. Builder COPY statements independently enumerate
the production entrypoints/directories, never `COPY . .` or the whole source root;
adding a new runtime directory requires review. Final copies are limited to compiled runtime,
production modules and package metadata; source maps/declarations are disabled.
This is static intent until CI inspects the actual image/layers and SBOM.

Run Compose independently per host with an approved registry image **including
`@sha256:<64 hex digest>`**. No build-on-production or mutable-tag promotion. The
template requires externally provided non-secret variables:

| Variable | Meaning |
|---|---|
| `FREEBUSY_IMAGE` | Approved immutable gateway image reference, not base image |
| `FREEBUSY_CONFIG_DIR` | Absolute, versioned directory containing reviewed config bundle |
| `FREEBUSY_SECRETS_DIR` | Absolute secret-store materialization directory outside Git |
| `FREEBUSY_INGRESS_APPROVED` | Exactly `public+private`, set only after ingress review |

Compose interpolation requires values but does not validate the digest's format;
the administrator/promotion pipeline must reject tags without a digest. Never put
secret contents in these variables, shell arguments, labels, build args or `.env`.

The config bundle must contain `gateway.json` and its directory, limits and
protocol-profile files. Relative references are resolved from `/etc/freebusy`,
not `/app`; arrange the reviewed bundle accordingly. Keep `127.0.0.1` and ports
8080/8081/8082 to match the proxy (or review all three together). Set production
environment/live access and replace all placeholders only under the live gates.
The executable refuses fake runtime providers; the repository example config
cannot be launched unchanged. The candidate protocol profile requires proof with
the actual native clients; never manufacture live evidence.

Mount exactly the four required secrets at their configured `/run/secrets` paths:
Graph PEM certificate **and matching private key**, Zimbra non-admin password,
and two distinct SHA-256 digest files for high-entropy inbound credentials. Use
the existing secret manager to provision direct regular files (no symlinks or hard
links), owned by container UID 1000 and mode 0400 or 0600; parent directories must be
traversable but not publicly accessible. With user-namespace remapping, provision
the correct mapped host UID and prove the in-container owner before startup.

File-backed Compose secrets are read-only bind mounts: do not rely on Compose
`uid`/`gid`/`mode` to repair host permissions. The runtime rejects the wrong owner,
group/other permissions, symlink parents or reused secret paths. Verify using
metadata only; never print contents. Rotate via a new approved secret generation
and recreate/remount the drained instance because an existing file bind may keep
the prior inode. [Compose secret permissions](https://docs.docker.com/reference/compose-file/services/#long-syntax-5).

The container runs UID 1000 with a read-only filesystem, no capabilities, no new
privileges, 1 CPU, 512 MiB memory/no extra swap, 128 PIDs and bounded logs. Its
application state is in bounded memory; it has no writable application mount or
tmpfs because the runtime needs no scratch files. These are candidate resource
limits, not benchmark evidence; administrators must measure them under approved
pilot load. No database or calendar
storage is deployed.

## Verification and promotion

Available offline checks (run from repository root with pinned Node24):

```sh
npm run verify
node_modules/.bin/js-yaml deploy/compose.yaml
```

An approved infrastructure environment must additionally run the following
with a Docker runtime and synthetic configuration/secret **files**; only an
authorized administrator performs the real deployment:

```sh
docker build --tag freebusy-gateway:local-review .
docker compose -f deploy/compose.yaml config --quiet
```

CI must scan the image, record SBOM/platform/image digest/source+lock hashes,
inspect final layers for forbidden files/dev packages, and confirm non-root UID,
read-only mounts, absence of writable application volumes, secret ownership,
healthcheck and SIGTERM handling.
Test the built image with fixture endpoints in an isolated no-external-egress
harness; never inject a fake provider into the production executable. Test the
rendered Nginx config with `nginx -t` and synthetic TLS identities, route/method
negative cases and no remote management access. Static YAML parsing alone is not
Compose schema validation, container execution or Nginx syntax validation.

Promotion records the tuple: source commit, tested image digest+platform,
configuration bundle hash/version, protocol/limits revisions, secret generation
IDs (not values), proxy/LB/firewall revision, approval and prior rollback tuple.
Keep the previous signed/reviewed artifacts available independently of either host.

## Rolling deployment, drain and rollback (administrator-owned)

1. Confirm live approvals/change window and the second host's useful native-path
   checks. Do not operate on both hosts at once.
2. Disable the chosen host in **both** LB pools; prevent new dispatch and drain
   existing work for at least the approved end-to-end budget. Health probes alone
   are not a drain control. Preserve the prior image/config/secret tuple.
3. Stop that host's gateway with SIGTERM, not SIGKILL. The runtime marks unready,
   aborts/drains within its 10-second grace; Compose waits 15 seconds. If it exceeds
   that bound, retain sanitized failure evidence and investigate, not infinite wait.
4. Recreate with the reviewed image/config and exact mounted secret generation;
   do not modify mounted configs in place. Confirm process liveness and readiness,
   denied cross-surface/management routes, TLS identity, then approved native
   synthetic checks and absence of privacy/auth/Unknown regressions.
5. Re-enable the host in both correct pools, observe, then repeat for the other
   host. Provider outage may degrade availability while readiness stays 200;
   do not reboot all gateways for Microsoft/Zimbra failure.
6. On regression, drain only the affected host and recreate the **previous image
   digest plus matching config/proxy revisions and still-valid secret generation**.
   Recheck health and native synthetic results before returning it to service.
   Never re-enable revoked secrets; coordinate a compatible rollback binding.

No database migration or calendar rollback is needed: cache is disposable and
starts cold. Tenant/mail-routing rollback belongs to its separate approved admin
runbook, not Compose. An instance loss can fail in-flight requests; HA does not
promise zero failed lookups. Rebuild a lost host from the recorded immutable tuple.

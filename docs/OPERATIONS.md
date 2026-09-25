# Production operations and release runbook

## Build and deployment

Use two separately hosted stateless instances and an HA ingress already operated by the organization. Build an immutable image using the exact approved Node 24 patch and base digest; npm ci uses the approved lock. Run as non-root with a read-only root filesystem, no Linux capabilities, no Docker socket, bounded CPU/memory and a tmpfs only where required.
Never claim Docker Compose on a single machine is host HA. The example architecture requires separate failure domains and a non-single-point ingress. Configure time synchronization on all hosts.
Staging and production configs are distinct. Startup validates all placeholders, URLs, principal/directory mappings, secret mounts, deadlines and protocol profiles; fail startup on invalid config. Fake providers are built only into lab entrypoints and cannot activate under NODE_ENV=production.
Keep build artifacts, signed/reviewed config and secret manager backups. No calendar data needs recovery from the gateway.

## Deadline / retry policy

The total request budget is 8 seconds by default, including token acquisition, retries and response rendering. Provider attempts get at most 3 seconds and no more than the remaining budget. Cancel queued and running work on deadline/disconnect.
At most one retry for transient 429/502/503/504 or a safe network failure, only within remaining budget. Respect Retry-After; if the requested wait exceeds the remaining budget, return Unknown instead of retrying early ([Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)).
Do not retry bad input or ordinary denied/not-found responses. A confirmed Zimbra token expiry permits one coordinated reauthentication within the same budget. Avoid retry multiplication: the v1 uses native fetch, with a single gateway retry owner.
Circuit breakers are independent per backend and classify backend/service failures separately from one user's permission/not-found failure. A 403 for one recipient must not disable availability for every user.

## Cache

Default TTL 30 seconds, bounded LRU memory and entries. Key: principal/surface + tenant/provider + canonical target ID + exact UTC window + interval + visibility/config revision. Check current authorization before cache access.
Never store raw Graph/Zimbra records. Cache only verified normalized results. Do not serve expired entries during backend outage. Permission revocation flushes relevant entries/config generation; document the maximum TTL/revocation window.
Deduplicate concurrent identical lookups with single-flight. A disconnected caller must not cancel shared work still needed by another caller; shared work has an independent capped deadline and subscriber accounting.

## Health and metrics

Management listener only. /healthz reports process/event-loop liveliness, with no provider calls. /readyz reports config loaded, listeners usable and not draining; do not restart every gateway because Microsoft is temporarily down. /metrics exposes bounded-cardinality telemetry.
Use separate low-frequency external synthetic checks against dedicated pilot identities to test true two-way availability. Scheduling of those checks belongs to your monitoring system, not a calendar sync worker.
Counters/histograms: requests by surface/outcome, normalized target results, parser rejection, backend attempt/latency/status category, cache hit/miss, pending work, breaker state and Unknown ratio. Redact identity and secrets. Alert on Unknown spikes, persistent auth failure, certificate/credential expiry and no live-synthetic success.
Proposed alerts: unexpected Unknown ratio >5% over 10 minutes; no successful synthetic check over 5 minutes; certificate expiry <30 days. Tune to the pilot, record final thresholds, and avoid alerting on expected denied test identities.

## Failure behavior

Provider timeout/failure → per-target Unknown / EWS failure, never free. Partial success returns valid results in original order plus failed entries. Malformed whole requests receive a protocol fault. Authentication failures use HTTP 401 without backend calls. Unsupported operation is rejected, not emulated with success.
Graph 5006/too many entries becomes Unknown, not truncated free/busy. Backend missing intervals are not assumed free until full successful coverage is established.

## Rolling release

1. Administrator exports current AAS/recipient/Zimbra settings privately and confirms rollback ownership.
2. Deploy one instance with the reviewed image/config while the other serves traffic. Confirm management readiness and synthetic native-path checks.
3. Shift a pilot subset if routing permits; otherwise use a preapproved maintenance change and narrow pilot domain.
4. Deploy second instance only after acceptance. Observe errors/Unknown, identity routing and mail delivery.
5. Roll back to previous image/config on new protocol, privacy or auth regression. Restore only the specifically changed routing objects; never bulk-delete all AAS entries.

## Shutdown and recovery

On SIGTERM mark unready, stop accepting new work, drain/abort within the configured grace period and terminate without dropping secrets into logs. Losing an instance can cause an in-flight query failure; HA reduces outages but does not guarantee zero failed requests.
Disaster recovery: provision clean host, restore reviewed image/config and secret bindings, validate health, then native synthetic checks; cache starts empty.

## Ownership and change tracking

Assign an owner for Graph app permissions/certificates, Zimbra service account/build patching, ingress/DNS/TLS, on-call and vendor/API compatibility.
Record a calendar reminder/task in your existing operations process to re-check Microsoft EWS/AAS policy before changes and to re-run native tests after tenant policy, Zimbra patch or client upgrades. This plan does not create a background monitoring service or promise future notifications.

## Ingress limits and source identity

Initial header/body-receive/keepalive and rate-control values are explicit in contracts/limits.json. They are proposed pilot defaults, not certified Microsoft request rates. Apply a bounded source-key table before authentication and principal limits after authentication. Trust proxy-derived source addresses only from configured ingress hops; do not allow arbitrary X-Forwarded-For to bypass limits. Because cloud requests can share source IPs, tune the pre-auth source rate after observing the approved pilot rather than hard-coding a tiny per-user assumption. Enforce compatible LB timeouts and body limits.

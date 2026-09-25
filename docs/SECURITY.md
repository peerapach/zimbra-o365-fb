# Security and privacy contract

## Principals and trust

Use distinct high-entropy integration credentials for the public Microsoft caller and the private Zimbra caller. Neither is the Graph app credential or the Zimbra account password.
The initial protocol candidate is HTTP Basic over TLS, which still requires proof with both native clients. Credentials are integration-specific, rotatable, and do not reuse a human password. If the actual caller requires a different mechanism, stop for a reviewed auth adapter; do not invent NTLM or accept anonymous calls.
No interactive login page, CAPTCHA, cookie session, arbitrary bearer token or blanket mTLS requirement may be inserted where the Microsoft caller cannot satisfy it. IP filtering is defense in depth, never proof of identity.
Resolve organization-wide caller authority from the authenticated integration principal and listener surface. Ignore/reject impersonation or arbitrary requester headers. The v1 grant intentionally allows that principal to see free/busy for all its opted-in targets; it does not preserve per-organizer ACLs.

## Secrets

Production app certificate private key and Zimbra service credentials are mounted read-only from an approved secret store. Secret files are outside the repository and limited to the service UID. No secrets in environment dumps, shell arguments, Dockerfile layers, container labels, capture files or LLM prompts.
For inbound Basic validation, this runtime stores a SHA-256 digest of the high-entropy password bytes and compares fixed-length digests in constant time; never log the received Authorization header. This is not a safe scheme for low-entropy or human-chosen passwords. Permit a bounded overlap of old/new credentials during rotation, then revoke the old credential and invalidate related cache.
Microsoft certificate rotation: load new app certificate, deploy, prove new token acquisition, remove old app certificate, test denial for old key. Zimbra token renewal: one single-flight reauthentication on a confirmed token-expiry failure, not an unlimited 401 loop.
Production credentials are separate from pilot credentials. Avoid developer-machine fallback credentials: explicit ClientCertificateCredential, not an ambient identity chain.

## Parser and transport controls

Require UTF-8 and approved SOAP/XML content types. Decode with fatal UTF-8 error handling; reject UTF-16 or unexpected encodings rather than scanning bytes as if they were UTF-8.
Use namespace-aware parsing; enforce exactly one SOAP Envelope/Body and one allowed operation. Reject DTD/DOCTYPE, custom entities, XInclude, external schema fetches, unknown mustUnderstand headers, duplicate singleton elements, excessive nodes/depth/text/attributes and multipart attachments.
Reject SOAPAction/body mismatches. Unknown prefixes are not automatically trusted; the namespace URI must match. A protocol fixture must not become a general XML passthrough.
Authenticate before expensive parsing/backend work, but apply cheap byte/header/rate limits even to unauthenticated requests. Count actual streamed bytes; Content-Length is not trusted. A client-specific request is cancelled on its deadline/disconnect. Coalesced work may continue only for other authorized subscribers, under its own bounded deadline; it must not become orphaned unbounded work.
Use fixed backend origins and `redirect: error`/equivalent. Explicit corporate CA support is allowed; disabling certificate/hostname checks is forbidden. Reject path/host override via incoming XML, email values, forwarded headers or redirects.

## Privacy boundaries

Build normalized objects with an allowlist of fields. Do not spread backend objects into responses/cache/logs. Drop subject, location, body, event IDs, attendee/organizer data and private details even when an upstream read permission returns them.
Never include full SOAP bodies, Graph JSON bodies, Authorization, authToken, cookies or raw email addresses in normal logs. Use correlation IDs and, only when necessary, HMAC-pseudonymized identity IDs with a separate log key. No email labels in Prometheus.
Return a non-enumerating availability failure for missing/denied/non-allowlisted targets. Keep detailed cause only in safe internal categories.
Production diagnostic capture is off by default, explicitly authorized, redacted and time-limited. Live fixtures belong in restricted storage; only scrubbed synthetic replacements go into Git.

## Microsoft permission nuance

Graph getSchedule may return more than availability ([API reference](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0), [schedule overview](https://learn.microsoft.com/en-us/graph/outlook-get-free-busy-schedule)). Calendar read credentials are not technically limited to a free/busy-only operation. Restrict resources through reviewed App RBAC and destinations/operations through the gateway, and document residual risk ([Exchange App RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)).
RBAC and Entra grants are additive. A broad Entra grant can defeat the intended restriction. Do not invent an App RBAC role that does not appear in the tenant. Real API negative tests are required.

## Defensive tests

Include unauthenticated requests, wrong-surface credentials, forbidden target with an existing cache entry, tenant/alias confusion, wrong namespace with familiar names, duplicate Body, DTD/entity payloads, overlong requests, deep XML, UTF-16 bypass, overlong chunked bodies, slow backend, attacker-controlled URL/Host, revoked credentials and sensitive-data log canaries.
Tests run locally with synthetic values and no internet egress. Do not scan Microsoft or Zimbra production with attack payloads.

# Architecture

## Direction A: Zimbra user reads Microsoft 365 availability

```text
Zimbra native scheduling view
  -> Zimbra installed Exchange availability provider
  -> private TLS gateway origin /EWS/Exchange.asmx
  -> authenticated zimbra-inbound principal
  -> explicit directory mapping + permission checks
  -> Graph getSchedule (Microsoft Graph v1.0)
  -> availability-only response back through the same path
```

## Direction B: Microsoft 365 user reads Zimbra availability

```text
Microsoft 365 native scheduling view
  -> Exchange Online (Microsoft 365 calendar backend; not another server to install)
  -> administrator-configured Availability Address Space
  -> public TLS gateway origin /autodiscover/autodiscover.xml
  -> public TLS gateway origin /EWS/Exchange.asmx
  -> authenticated m365-inbound principal
  -> explicit directory mapping + permission checks
  -> private Zimbra SOAP GetFreeBusy
  -> availability-only response back through the same path
```

The gateway implements a narrow EWS-compatible *inbound* interface. It never calls the cloud EWS service. Graph is an outbound client API here, not a provider registration API for native scheduling. This design follows the external-routing precedent in the [Microsoft AvailabilityAddressSpace reference](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/add-availabilityaddressspace?view=exchange-ps) and an [external availability example](https://knowledge.workspace.google.com/admin/sync/allow-exchange-users-to-see-calendar-availability-data), subject to live proof.

## Deployment boundaries

Use two gateway instances on separate hosts/failure domains and the organization's existing highly available load balancer. A single LB VM remains a single point of failure; two containers on one VM do not provide host HA.
Production listeners are logically separate:

| Listener | Exposure | Paths | Permitted principal/provider |
|---|---|---|---|
| 8080 | Only through authenticated public TLS ingress | POST /autodiscover/autodiscover.xml; POST /EWS/Exchange.asmx | m365-inbound → Zimbra |
| 8081 | Internal Zimbra ingress only | POST /EWS/Exchange.asmx | zimbra-inbound → Graph |
| 8082 | Private management only | GET /healthz, /readyz, /metrics | monitoring/network access control |

These are application ports behind TLS termination, not public plain-HTTP ports. Re-encrypt cross-host proxy-to-gateway traffic or use an approved protected transport. No gateway app port, management endpoint, Zimbra admin port or debug endpoint is published directly to the internet.
The app uses immutable listener/surface context. It does not trust an arbitrary Host/X-Forwarded-* header to decide the caller's authority.
Outbound allowlist: Microsoft login/token endpoint, Graph host, fixed internal Zimbra SOAP origin, and narrowly approved operational dependencies. Runtime does not contact GitHub/npm to retrieve schemas.

## Core pipeline

Transport/auth → bounded XML decode → EWS contract validation → caller policy → identity mapping → normalized query → per-target cache/provider → normalized results → bounded EWS renderer.
Every stage accepts explicit dependencies. Tests inject deterministic clocks, token suppliers and fake transports. Providers never receive raw XML or arbitrary target URLs.

## Directory mapping instead of domain guesses

Use a validated read-only JSON configuration, deployed with the application. Each entry names provider, canonical SMTP address, aliases, optional Graph object ID, and inbound surfaces allowed to see it.
Same-domain coexistence needs administrator-approved availability aliases and corresponding recipient/mail-routing configuration. Mapping an alias in this JSON alone does not make Microsoft 365 discover the user or deliver mail.
Never create shadow mailboxes to solve routing as an unapproved fallback. Never send an unresolved Zimbra target back through Zimbra's external provider: that can recurse into the gateway.

## Why no database?

There is no calendar state to synchronize. Per-instance LRU cache and backend tokens are disposable. Configuration, secrets, deployment metadata and evidence still require durable, access-controlled storage outside the process.
Two replicas may have different cache contents. Authorization/config revision is included in cache keys; expired entries are not served during an outage. Coordinated invalidation after permission revocation uses config revision + rolling restart and has a documented maximum exposure window.

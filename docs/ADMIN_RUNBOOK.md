# Administrator-only runbook

These are templates and discovery steps for authorized administrators, not commands to run automatically in production. Placeholder values must be supplied locally; credentials must not be pasted into chat or the repository.

## Inventory (read-only)

Zimbra administrator records `zmcontrol -v`, package/build provenance, installed free/busy providers (`zmprov gafbp` / local help), actual client, and existing free/busy push configuration. Inspect only named attributes and redact passwords; do not dump all global config into an LLM prompt.
Useful named attributes: zimbraFreebusyExchangeURL, zimbraFreebusyExchangeServerType, zimbraFreebusyExchangeAuthScheme; also inspect account/COS/domain overrides and freebusy_disable_nodata_status via local tooling. The schema contains these settings, but runtime behavior depends on the installed build ([Zimbra configuration guide](https://zimbra.github.io/documentation/zimbra-10/config-guide.html), [administrator guide](https://zimbra.github.io/documentation/zimbra-10/adminguide.html)).
M365 administrator exports current Get-AvailabilityConfig, Get-AvailabilityAddressSpace, relevant recipient/contact identities and accepted-domain/mail-routing settings into restricted storage. Record exact objects that will change and how to restore them.
Do not modify the existing AAS or OrgWideAccount for another integration without an impact review.

## Graph app / permissions

Create a dedicated application identity and certificate. The runtime private key stays in secret storage. Register the corresponding Exchange service-principal pointer with the correct Entra service-principal object ID, not the app-registration object ID ([Exchange App RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)).
Default proposal is a scoped `Application Calendars.Read` role assignment over approved pilot targets, with no tenant-wide duplicate Entra calendar grant. Enumerate the tenant's actual roles before selecting one. Do not invent `Application Calendars.ReadBasic`.
Template (review and replace placeholders):

```powershell
# Requires an existing authenticated admin session; this does not connect automatically.
Get-ManagementRole -Identity 'Application Calendars.Read'
# Use actual tenant-approved app/service-principal IDs and pre-reviewed scope.
New-ServicePrincipal -AppId $AppId -ObjectId $ServicePrincipalObjectId -DisplayName $DisplayName
New-ManagementRoleAssignment -Name $AssignmentName `
  -Role 'Application Calendars.Read' -App $ServicePrincipalObjectId `
  -CustomResourceScope $ApprovedScopeName
Test-ServicePrincipalAuthorization -Identity $ServicePrincipalObjectId -Resource $AllowedMailbox
Test-ServicePrincipalAuthorization -Identity $ServicePrincipalObjectId -Resource $DeniedMailbox
```

Check for existing service principals/assignments first; don't create duplicate objects. Role tests exclude separately granted Entra permissions; real API negative tests remain mandatory ([Exchange App RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)).
The administrator creates the ManagementScope using the organization's approved filter. Do not choose membership or broaden the scope for convenience.

## Exchange Online → gateway pilot

Provision one pilot mail contact / supported recipient with a distinct availability routing alias, visible in the address list and delivering invitations to the existing Zimbra user. When both populations share a domain, do not route the entire shared domain to the gateway. Use an approved alias domain and test mail delivery ([external availability example](https://knowledge.workspace.google.com/admin/sync/allow-exchange-users-to-see-calendar-availability-data)).
The gateway's public TLS origin must be reachable by Exchange Online; no anonymous calendar access is enabled. Certificate must be trusted and hostname-correct. An interactive WAF challenge cannot be used for this server-to-server path.
Review/create AvailabilityConfig first if missing; it is a prerequisite in the [Microsoft cmdlet documentation](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/add-availabilityaddressspace?view=exchange-ps). The OrgWideAccount is the approved Exchange-side identity for availability configuration, not automatically the Graph app identity and not automatically the external gateway credential.
Minimal AAS template:

```powershell
# Run only after AvailabilityConfig and routing changes are reviewed.
$GatewayCredential = Get-Credential  # Dedicated external gateway integration credential.
Add-AvailabilityAddressSpace `
  -ForestName $PilotAvailabilityDomain `
  -AccessMethod OrgWideFB `
  -Credentials $GatewayCredential `
  -TargetAutodiscoverEpr $ApprovedAutodiscoverUrl
```

Check current cmdlet applicability and exact configuration behavior in this tenant ([Microsoft cmdlet reference](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/add-availabilityaddressspace?view=exchange-ps)). No unconditional Remove-AvailabilityAddressSpace, no disabling unrelated OrganizationRelationships and no global EWS re-enablement.
If an entry already exists, STOP for comparison and controlled replacement. Store a rollback plan and the pre-change state; raw credentials are not included in the export.
Complete a native-calendar pilot using the original probe timeline, then record exact protocol/auth/namespace/timezone behavior.

## Zimbra → gateway pilot

Use the installed Exchange EWS free/busy provider if present. Set its URL to the **private gateway origin**, server type `ews`, and a dedicated inbound gateway credential via the administrative path already approved by your organization ([Zimbra configuration guide](https://zimbra.github.io/documentation/zimbra-10/config-guide.html), [administrator guide](https://zimbra.github.io/documentation/zimbra-10/adminguide.html)).
The provider uses requester/account/domain/global configuration resolution ([upstream provider source](https://raw.githubusercontent.com/Zimbra/zm-mailbox/develop/store/src/java/com/zimbra/cs/fb/ExchangeEWSFreeBusyProvider.java)); don't set only an arbitrary target-domain field and assume it will apply. Confirm the exact requester path in the installed build during the pilot.
Do not populate replication-only foreign-principal/legacyExchangeDN/public-folder settings just because an old guide mentions them. This gateway does not implement public-folder publication or event copies.
The admin-console connection test can call non-availability EWS operations; use native scheduling lookup as the acceptance test. A failure of unsupported GetFolder is not a reason to invent a fake folder server.
Any restart or logging increase is an administrator-approved maintenance action. Revert temporary verbose logs/capture after testing.

## Zimbra service access

Create a normal dedicated runtime account. Grant only the organization-approved free/busy visibility to opted-in pilot targets using the exact local version's supported account/folder rights. Inspect local `zmprov` help/schema before any grant command; this pack does not assume broad calendar read/admin rights.
Prove real SOAP outcomes for allowed free, busy, private, denied and nonexistent targets. Audit any pre-existing anonymous availability endpoint separately. Do not change all users to public to make the gateway work.

## End-to-end acceptance

Create known test appointments manually in each pilot calendar: free slot, tentative, busy and out-of-office, plus a private event whose title is a synthetic canary. Use both native scheduling UIs, not just API tools.
Verify aliases resolve correctly, email/invitations are delivered as before, private canaries never leave the gateway, failures display as no information and all routine client profiles are supported.
Test with the integration prohibited from calling Exchange Online EWS. This is not a tenant-wide EWS disable experiment and does not certify future Microsoft policy.

## Rollback

Restore the previous specific AAS/recipient/Zimbra setting values and last approved gateway image/config. Retain existing mailboxes/events unchanged. Remove only newly created pilot objects after verifying they are not used by other integrations. Revoke pilot credentials/certificates through the credential owner.

# Original synthetic fixtures

These fixtures are invented test schedules at .invalid identities, not copied user data and not observed Microsoft/Zimbra traffic. Their metadata/manifest explicitly says synthetic. Golden UTC and Bangkok times describe the same four-hour window; the expected merged string is 02133000.

The EWS response and POX EXPR profile are **candidates for a live feasibility test**. Well-formed XML is not schema validation or native compatibility. Administrators must capture and approve the actual client profile. The EWS initial request uses a named UTC context; it is not a claim to duplicate Zimbra's full legacy timezone request.

Graph private-data sentinels are intentional: no sentinel may leave normalization through output, cache or logs. Zimbra n is no-data, not free.

Do not update golden vectors or the manifest simply because a test fails. A protocol correction needs an independently reviewed source and expected values. The manifest is an integrity check, not a cryptographic trust boundary when the same contributor can edit it.

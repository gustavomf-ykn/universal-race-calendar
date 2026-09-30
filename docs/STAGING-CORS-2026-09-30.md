# Administrative review browser validation — 2026-09-30

Environment: race-platform-staging only. API: https://universal-race-calendar.onrender.com.

The authenticated panel attempted to publish GARUVA RUN (`evt_b94d925f5427ad6c39949b2f`). The event remained `pending_review`; no successful publication is claimed.

A public OPTIONS request for the administrative PATCH route returned HTTP 204 with `Access-Control-Allow-Methods: GET,HEAD,POST`. HTTP 204 alone therefore did not validate the preflight. The browser cannot send the review request because PATCH is absent.

The API now explicitly advertises its HTTP methods through the existing origin allowlist. JWT/admin authorization is unchanged. Regression coverage checks publication and preview origins, Authorization and Idempotency-Key headers, an untrusted origin, and unauthenticated PATCH rejection. Six API public/guard tests pass locally.

This fix requires an API deployment, not a migration or frontend publication. After deployment, repeat OPTIONS and publish the reviewed event in the authenticated panel; verify its public visibility and audit record. Do not mark this browser scenario approved before that check.

At diagnosis: 28 events, 822 results (435 Mountain Do and 387 Garuva), no active executor heartbeat. TicketSports task `67e76b79-7909-4673-b34c-2dc7207457bc` remains queued with batchSize 5. The historical 120/15 requests remain held. No worker was started for this diagnosis.

Earlier technical XLSX checks passed for 23-row simple/full catalogs and 435-row results, including private Storage and signed downloads. Browser download remains unconfirmed after ERR_BLOCKED_BY_CLIENT; technical download does not establish browser acceptance.

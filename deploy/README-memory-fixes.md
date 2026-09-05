# Replay server memory controls

`server/bufferCache.mjs` bounds the ATIF live chunk cache to 128 MiB of owned
Buffer payloads and 4096 entries. It uses least-recently-used eviction, a two-minute
idle expiry, and an unreferenced 30-second background sweep. Parsed trajectory
objects are scoped to requests instead of being retained in a global cache.
Oversized chunks are still served, but are not cached. Cache eviction must never
truncate a trajectory or change its incremental cursor / overlap recovery.

The budget is a retained cache payload limit, not a process RSS limit. In-flight
downloads, parsed objects, JSON serialization, and allocator overhead can use
additional memory. Cache hits now reparse JSON; this trades some CPU for bounded,
accurately accounted persistent payload storage. The existing host pressure guard
continues to apply.

`server/proxyApi.mjs` propagates interrupted client responses to both the upstream
request and response, including cancellation before response headers arrive.
Ordinary completed responses retain normal HTTP keep-alive behavior. Backend
response errors close the downstream response instead of becoming unhandled errors.

Run `npm test` for cache budget/expiry, incremental ATIF compatibility, and real
HTTP cancellation regression tests. These server-only changes take effect after
`systemctl --user restart replay-18768.service`; no frontend build or oss-replay
restart is needed.

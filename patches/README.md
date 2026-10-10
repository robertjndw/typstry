# Dependency patches

Applied by pnpm on install (see `patchedDependencies` in `pnpm-workspace.yaml`). Each one is a stopgap until upstream ships the fix.

## loro-websocket@0.6.2

The client closes its socket with code 1001 when the browser goes offline and on a ping timeout. Browsers only accept 1000 or 3000-4999 from scripts, so `close()` throws, the socket stays open, and the client never reconnects: the status sticks at "Offline" after a network blip. The patch changes both calls to 1000.

Fixed upstream in [loro-dev/protocol#65](https://github.com/loro-dev/protocol/pull/65), which is merged but not yet released. It is listed for loro-websocket 0.6.3 in the pending release PR [#48](https://github.com/loro-dev/protocol/pull/48).

Once 0.6.3 is on npm:

1. Bump `loro-websocket` in `apps/web/package.json` and check its changelog for the fix.
2. Delete `loro-websocket@0.6.2.patch` and its `patchedDependencies` entry.
3. If no patches are left, remove this directory and the `COPY patches patches` line in the `Dockerfile`.
4. Run `pnpm test:e2e`. "edits made offline sync once back online" in `apps/web/e2e/offline.spec.ts` fails if the bug comes back.

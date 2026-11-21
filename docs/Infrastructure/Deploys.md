# Deploys

## What it is

`tools/deploy.sh` ships the server and web bundles to elantris as a **release**: a directory of its
own, beside the one running. It backs up, migrates, switches, checks health, and rolls back on its
own if the new release is not healthy. `tools/rollback.sh` does the same rollback by hand, for a
problem found after a deploy passed.

## Key files

- [../../tools/deploy.sh](../../tools/deploy.sh) — the deploy, top to bottom
- [../../tools/rollback.sh](../../tools/rollback.sh) — back one release
- [../../tools/lib/release.sh](../../tools/lib/release.sh) — releases on a host, and moving between them
- [../../apps/server/src/migrate.ts](../../apps/server/src/migrate.ts) — `migrate:show|run|revert|revert-applied`
- [../../apps/server/systemd/](../../apps/server/systemd/) — the server and migrate units, which run from the links
- [../../tools/host/install-deploy-privileges.sh](../../tools/host/install-deploy-privileges.sh) — the one-time move to releases, the units, the sudoers lines

## How it works

```
~/tempestas/
  releases/
    20261121-101500-e95e066/   server/  web/  release-id  applied-migrations.json
    20261121-143000-1a2b3c4/   …
  current  -> releases/20261121-143000-1a2b3c4    # tempestas-server.service runs this
  migrator -> releases/20261121-143000-1a2b3c4    # tempestas-migrate@ runs this
```

A release ID is `<UTC time>-<commit>`, with `-dev` when the commit is not `origin/main` and
`-dev-dirty` with uncommitted changes. The server reports it as `releaseId` on `/api/health`.

```bash
tools/deploy.sh                          # elantris
tools/deploy.sh --allow-irreversible     # when a pending migration cannot be reverted
tools/rollback.sh                        # back to the release before current
```

The deploy, in order:

1. **The gate and the web build**, here. Never on the Pi: a build there puts the burner controller
   in reach of the OOM killer.
2. **Ship** the new release beside the live one. `node_modules` is hard-linked from the live
   release when the lockfile is unchanged, otherwise `npm ci` runs on the host.
3. **Point `migrator` at it** and run `migrate:show`, which exits 0 when nothing is pending, 3 when
   something is, 4 when something pending cannot be reverted.
   - 0: back up anyway.
   - 3: `migrate@run`, which backs up first and applies everything in **one transaction**.
   - 4: refuse, unless `--allow-irreversible`.
   - Anything else, or a failure: point `migrator` back and stop. Nothing was switched.
4. **Point `current` at it and restart.**
5. **Health check**, for 60 s: `"db":true`, and `releaseId` is the new one, so the old process
   answering is never mistaken for the new.
6. **Roll back if it fails**: stop the server, run `migrate@revert-applied` **with the new
   release's code**, which knows its own migrations, point both links back, restart, check again.
7. **Prune** to the newest 3 releases, never removing what a link points at.

`run` writes what it applied to the release's `applied-migrations.json`. `revert-applied` reverts
exactly that list, in one transaction, and only if those are still the newest applied migrations:
anything applied since would be undone with it, so it refuses and asks for a revert by hand.

### When the revert itself fails

Some `down`s refuse once the new code has written rows the old schema cannot hold (see
[Migrations](Migrations.md)). Then the schema is still the new release's, so the rollback
**restarts the new release**, the code that matches it, rather than leave the server stopped: a
stopped server lets every node's dead-man fire, and the pumphouse heater is not a thing to leave
off. It prints the `pg_restore` command for the deploy's backup. Restoring is never automatic,
because it also throws away everything written since.

## Pitfalls

- **Run `tools/install-deploy-privileges.sh` once before the first release deploy.** It moves the
  old `~/tempestas/dist` into a release named `<date>-before-releases`, installs the units that run
  from `current` and `migrator`, and adds the sudoers lines for `stop` and `revert-applied`. Until
  then the deploy stops and says so. That first release predates `releaseId`, so its health is known
  only by `"db":true`.
- **A release is never shipped over.** The ID has the second in it; a clash means a retry within the
  same second, and the deploy stops rather than mix two builds.
- **`migrator` is not always `current`.** During a deploy it points at the new release; a deploy that
  stops before switching points it back. A hand-run `tempestas-migrate@run` uses whatever it points
  at.
- **Each rollback reverts what the release it leaves applied**, and clears that release's list.
  Rolling back twice reverts two deploys' migrations, newest first.
- **greenhouse** runs Postgres in Docker and has no backup unit, so the deploy stops there at the
  privilege check. It is for elantris.

## When to update this file

- The release layout, the links, or the order of the deploy changes
- A `show` exit status is added
- A deploy or rollback goes wrong in a way the next person should be warned about

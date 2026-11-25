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
- [../../tools/lib/agent-bundle.sh](../../tools/lib/agent-bundle.sh) — the agents' release bundles: build, ship, prune
- [../../apps/agent-linux/agent-files.sh](../../apps/agent-linux/agent-files.sh) and [../../apps/agent-micropython/agent-files.sh](../../apps/agent-micropython/agent-files.sh) — what each agent is made of, for its own deploy and for a bundle
- [../../apps/server/src/app/agent-releases/](../../apps/server/src/app/agent-releases/) — the server verifies and offers them

## How it works

```
~/tempestas/
  releases/
    20261121-101500-e95e066/   server/  web/  release-id  product-version  previous-release  applied-migrations.json  backup-before-migrations  healthy
    20261121-143000-1a2b3c4/   …
  current  -> releases/20261121-143000-1a2b3c4    # tempestas-server.service runs this
  migrator -> releases/20261121-143000-1a2b3c4    # tempestas-migrate@ runs this
```

A release ID is `<UTC time>-<commit>`, with `-dev` when the commit is not `origin/main` and
`-dev-dirty` with uncommitted changes. The server reports it as `releaseId` on `/api/health`.

The **product version** names what was shipped rather than when.
[`tools/describe-product-version.sh`](../../tools/describe-product-version.sh) prints it from the highest
`vX.Y.Z` tag reachable from `HEAD`, on any branch, with `1.4.0-dev.N` below `1.4.0`:

| Where `HEAD` is                       | Version                          |
| ------------------------------------- | -------------------------------- |
| at `v1.3.0` on `main`                 | `1.3.0`, a release               |
| 5 commits past it, on any branch      | `1.3.0+5.g<commit>`              |
| at `v1.4.0-dev.1`, tagged on a branch | `1.4.0-dev.1`, a named dev build |
| with uncommitted changes              | any of these, plus `dirty`       |
| before the first tag                  | `0.0.0+N.g<commit>`              |

So a branch always has a version, and a tag such as `v1.4.0-dev.1` gives a dev build a name to
install and talk about. Only a bare `X.Y.Z` from `main` is a release. The script refuses a shallow
clone, which would hide the tags, and the deploy fetches tags with `main`. The deploy writes the
version to `product-version`, and the server reports it as `productVersion` on `/api/health`.
Each agent keeps its own version, from its contract, as the [MQTT Contract](MQTT%20Contract.md)
describes.

```bash
tools/deploy.sh                          # elantris
tools/deploy.sh --allow-irreversible     # when a pending migration cannot be reverted
tools/rollback.sh                        # back to the release current replaced
```

The deploy, in order:

1. **Check the host** is ready: the sudoers lines, the release layout, and `migrator` on `current`.
   Before the build, so a host that would refuse says so in seconds.
2. **The gate and the web build**, here. Never on the Pi: a build there puts the burner controller
   in reach of the OOM killer.
3. **Ship** the new release beside the live one, recording the live one's ID in
   `previous-release`. `node_modules` is hard-linked from the live release when the lockfile is
   unchanged, otherwise `npm ci` runs on the host. Ship each agent's
   [release bundle](#agent-release-bundles) too.
4. **Point `migrator` at it** and run `migrate:show`, which exits 0 when nothing is pending, 3 when
   something is, 4 when something pending cannot be reverted.
   - 0: back up anyway.
   - 3: `migrate@run`, which backs up first and applies everything in **one transaction**.
   - Either way the release records which backup was taken, in `backup-before-migrations`.
   - 4: refuse, unless `--allow-irreversible`.
   - Anything else, or a failure that left nothing applied: point `migrator` back and stop. Nothing
     was switched.
   - A `run` that failed but whose migrations are applied, or may be: stop with `migrator` left on
     the new release, whose record a revert needs. The next deploy refuses until it is resolved.
   - `run` exits 5 when it applied the migrations but could not record them. The deploy stops there
     too, and says so: no rollback could undo them.
   - When `run` or `revert-applied` fails, the deploy asks `show` what the database now holds
     rather than trusting the status: a dropped ssh or a record that would not write can fail a
     command whose transaction committed.
5. **Point `current` at it and restart.**
6. **Health check**, for 60 s: `"db":true`, and `releaseId` is the new one, so the old process
   answering is never mistaken for the new. A failure to switch or restart counts as a failed check.
7. **Roll back if it fails**: stop the server, run `migrate@revert-applied` **with the new
   release's code**, which knows its own migrations, point both links back, restart, check again.
8. **Mark it `healthy`** once it passes, and **prune** to `current` and the two releases a
   rollback would go back through from it, following `previous-release`, plus whatever `migrator`
   points at. A release that failed, or stopped before switching, goes with the next prune.

`run` writes what it applied to the release's `applied-migrations.json`. `revert-applied` reverts
exactly that list, in one transaction, and only if those are still the newest applied migrations,
by the order they were applied rather than their timestamps: anything applied since would be undone
with it, so it refuses and asks for a revert by hand.

`rollback.sh` goes back to the release in `previous-release`: the one that ran when current
shipped, so the only one whose schema reverting current's migrations leaves. A rollback never
skips a release, as one skipped could still have its migrations applied.

### Agent release bundles

The deploy also bundles each agent, for the server to offer the nodes through the
[update command](MQTT%20Contract.md#the-update-command):

```
~/tempestas/agent-releases/
  agent-linux/1.1.4/         manifest.json  files/src/tempestas_agent/…
  agent-micropython/1.1.2/   manifest.json  files/main.py  files/boards/pico_w.py  …
```

- **Only a clean `origin/main` deploy bundles the agents.** A `-dev` or `-dev-dirty` one skips them
  and says so: what a bundle holds also depends on `tools/lib/`, outside the agent's own directory.
- **The files are the ones the agent's own deploy ships**, tracked in git, plus its stamped
  `deployed_version.py`. A Pico's `settings.py` and `credentials.py` belong to that node and are
  never bundled. Where the hand deploy copies one board file to `board.py`, a bundle carries every
  board under `boards/`, and the node installs its own as `board.py`
  ([the update command](MQTT%20Contract.md#the-update-command)).
- **A bundle never stops the server deploy.** An agent that cannot be versioned, copied or shipped
  is named and skipped; a ship that fails partway leaves only a dot-name, which the next prune
  clears.
- **`manifest.json`** names the `app`, `version`, `contractMajor` and `contractMinor`, and a sha256
  for every file.
- **Beside the releases, not in one**, so a server rollback keeps them. A version already on the host
  is never shipped over, but is checked against the one just built; when they differ the deploy
  warns, and prints the command that removes it so the next deploy ships it fresh. A new version
  lands under a dot-name, which the server skips, and is renamed into place. The newest 2 versions
  of each agent on each contract major are kept, since a node is offered only its own major. They
  are pruned before the restart, as the server reads the bundles only when it starts.
- **The server verifies them at startup.** One whose files disagree with its manifest is logged and
  not offered. `GET /api/agent-releases` lists the rest, and serves each manifest and the files it
  lists under `/api/agent-releases/<app>/<version>/`, from the bytes it verified, held in memory:
  an `update` pins the manifest's sha256, so what is served never changes under it until the next
  restart, whatever a later deploy does on disk.
- **A node is offered** the newest bundle for its agent on its contract major, when it is newer by
  number (1.0.10 is newer than 1.0.9), as `availableUpdate` on the Nodes page. A node on a `-dev`
  build is offered it whenever it is on the same contract minor or later: a branch's own commits
  count toward its patch too, so its patch cannot say which is newer. Only from contract
  1.1, which added `update`: a node before it never subscribes, and one that has never sent
  `agentName` needs a deploy by hand first.
- **A node downloads from `AGENT_RELEASES_URL`**, set in `/etc/tempestas/server.env` to the
  server's address as the nodes reach it, such as `http://192.168.2.70:7000`. The server cannot
  work it out: behind a proxy or on a second interface, its own idea of its address is not the
  nodes'. Until it is set to a plain http(s) address, scheme, host and port only, the node page
  disables the update button and says why, and the server logs it at startup. See
  [Updating a node from the web](Nodes.md#updating-a-node-from-the-web).

### When the revert itself fails

Some `down`s refuse once the new code has written rows the old schema cannot hold (see
[Migrations](Migrations.md)), and a revert whose backup fails never runs. Then the schema is still
the new release's. Expand-contract means both releases run on it, so rather than leave the server
stopped, the rollback **restarts whichever of the two is marked `healthy`**: the release before,
when a deploy's new release failed its check; the current one, for a `rollback.sh`. A stopped
server lets every node's dead-man fire, and the pumphouse heater is not a thing to leave off.
`migrator` stays on the new release, whose list still names what is applied. It prints the `pg_restore` command for the backup that release recorded before it migrated,
not the newest in the journal: the revert takes a backup of its own, with the wrong schema. Restoring
is never automatic, because it also throws away everything written since.

Whenever the rollback does not finish, the deploy says so and says what is running; it never
reports a rollback that did not happen.

## Pitfalls

- **Run `tools/install-deploy-privileges.sh` once before the first release deploy.** It moves the
  old `~/tempestas/dist` into a release named `<date>-before-releases`, installs the units that run
  from `current` and `migrator`, and adds the sudoers lines for `stop` and `revert-applied`. Until
  then the deploy stops and says so. That first release is marked `healthy`, since it is the one
  running, and predates `releaseId`, so its health is known only by `"db":true`.
- **A release is never shipped over.** The ID has the second in it; a clash means a retry within the
  same second, and the deploy stops rather than mix two builds.
- **`migrator` is not always `current`.** During a deploy it points at the new release; a deploy that
  stops before switching points it back. After a failed revert it stays on the release whose
  migrations are still applied, and a deploy cut short leaves it on the new one. While the two
  differ, `deploy.sh` and `rollback.sh` refuse to start and print how to put `migrator` back. A
  hand-run `tempestas-migrate@run` uses whatever it points at.
- **Each rollback reverts what the release it leaves applied**, and clears that release's list.
  Rolling back twice reverts two deploys' migrations, newest first.
- **A unit change ships only with `tools/install-deploy-privileges.sh`.** The deploy ships
  releases, not `apps/server/systemd/`; rerun the installer after changing a unit there.
- **greenhouse** runs Postgres in Docker and has no backup unit, so the deploy stops there at the
  privilege check. It is for elantris.

## When to update this file

- The release layout, the links, or the order of the deploy changes
- A `show` exit status is added
- What goes in an agent's bundle, or the manifest's fields, changes
- A deploy or rollback goes wrong in a way the next person should be warned about

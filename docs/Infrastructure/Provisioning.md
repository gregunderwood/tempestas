# Provisioning a box

## What it is

Turning a bare Pi into a tempestas box, and the things that differ between the
two we have. Written from doing it to `greenhouse` on 2026-09-10; `elantris` was
done earlier by hand.

> [!note] Status
> `greenhouse` is provisioned but **nothing is enabled**. It runs no tempestas
> service yet - the legacy Flask app still owns its sensor and relays. See
> [Multi-Controller](../Multi-Controller.md) for the cutover.

## The two boxes are not the same

|          | `elantris`                         | `greenhouse`                                  |
| -------- | ---------------------------------- | --------------------------------------------- |
| Board    | Pi 4B, arm64 trixie                | Pi 5, **armhf** userland on an aarch64 kernel |
| Node     | nvm, symlinked to `/usr/local/bin` | same, `linux-armv7l` build                    |
| Postgres | bare metal                         | **Docker**, `postgres:17`                     |
| Broker   | mosquitto, local                   | none - points at elantris                     |
| Role     | `leader`                           | **`follower`**                                |

The 32-bit userland costs less than it looks. Node publishes `linux-armv7l`
through 22, the official Postgres image publishes `linux/arm/v7`, and every
runtime dependency of the server is pure JS. `lgpio`, `paho-mqtt` and `smbus2`
all build on armhf, and the agent needs only Python >= 3.11 against the 3.11.2
Raspbian ships.

## Steps

1. **Node**, via nvm, then symlinked. systemd cannot see nvm.

   ```bash
   nvm install 22
   sudo ln -sfn ~/.nvm/versions/node/v22.23.2/bin/node /usr/local/bin/node
   sudo ln -sfn ~/.nvm/versions/node/v22.23.2/bin/npm  /usr/local/bin/npm
   ```

   ⚠ The symlink must be called **`node`**. Naming it something else breaks
   `npm`, whose shebang is `#!/usr/bin/env node`. Verify the way systemd will
   see it, with no profile: `env -i PATH=/usr/local/bin:/usr/bin:/bin node -v`.

2. **Postgres.** On greenhouse, in Docker with a named volume and a restart
   policy, because Raspbian armhf has only Postgres 15 and the official image
   has `linux/arm/v7`:

   ```bash
   sudo docker run -d --name tempestas-db --restart unless-stopped \
     --env-file /etc/tempestas/db.env \
     -e POSTGRES_USER=tempestas -e POSTGRES_DB=tempestas \
     -v tempestas-pgdata:/var/lib/postgresql/data \
     -p 127.0.0.1:5433:5432 postgres:17
   ```

   Bound to **127.0.0.1**, and on 5433 because the legacy stack still holds 5432. `--env-file` is read by the docker _client_, so a 0600-root secret
   needs `sudo docker`, not just membership of the `docker` group.

3. **Ship the code.** Built on the Mac, never on the Pi - an Angular production
   build peaks well beyond what these boxes have spare.

   ```bash
   rsync -a --delete dist/apps/server/      HOST:~/tempestas/dist/apps/server/
   rsync -a --delete dist/apps/web/browser/ HOST:~/tempestas/dist/apps/web/
   ssh HOST 'cd ~/tempestas/dist/apps/server && npm ci --omit=dev'
   ```

   Note `browser/` is flattened INTO `dist/apps/web/`. The server serves
   `../web` relative to its own bundle, so keeping the extra directory level
   leaves `index.html` one deeper than it looks and every deep link 404s while
   `/` still works.

4. **Agent environment**: `uv sync --extra gpio` in `apps/hardware`.

5. **Secrets**, all `0600 root` under `/etc/tempestas/`: `db.env`,
   `server.env`, `agent.env`. Credentials never go in `agent.toml`; systemd
   reads the env files as root before dropping privileges, which a hand-typed
   command cannot do without putting a password in shell history or `ps`.

6. **Units**, copied to `/etc/systemd/system/` and verified:

   ```bash
   sudo systemd-analyze verify tempestas-server.service
   ```

   ⚠ **Do not install them under a `umask 077` shell.** The files land `0600`
   root, and while systemd can still read them, nothing else can - including
   `systemctl cat`, which then fails with a bare "Permission denied" that looks
   like something else entirely.

7. **Migrations**, through the unit rather than by hand, so the password is
   never an argument:

   ```bash
   sudo systemctl start tempestas-migrate@show   # read it first
   sudo systemctl start tempestas-migrate@run
   ```

## ⚠ `Requires=postgresql.service` has to be edited, not dropped in

The shipped units hard-require `postgresql.service`. greenhouse has no such
unit, and `Requires=` on a missing unit makes the service fail to start.

A drop-in **does not fix this on systemd 252**. The documented reset - an empty
`Requires=` followed by the replacement - loads (it shows in `DropInPaths`) and
the old dependency survives anyway:

```
Requires: sysinit.target -.mount postgresql.service docker.service
```

So on greenhouse the installed copies of `tempestas-server.service` and
`tempestas-migrate@.service` are edited in place to require `docker.service`,
with a comment saying why. Re-installing those units from the repo will undo it,
and the symptom is a service that refuses to start with "Unit
postgresql.service not found".

## ⚠ Broker credentials: generate the hash ON the broker

`mosquitto_passwd` writes a PBKDF2 iteration count into the hash, and the
default changed between releases: the Mac's **2.1.2 writes 1000**, the Pi's
**2.0.x writes 101**, and the 2.0 broker rejects the 1000-iteration entries. It
presents as `Connection Refused: not authorised`, which reads like a wrong
password rather than a format mismatch.

So build entries with the broker's own tool:

```bash
sudo mosquitto_passwd -b /etc/mosquitto/tempestas.passwd <user> '<password>'
sudo chown root:root /etc/mosquitto/tempestas.passwd    # 2.0 warns, future versions refuse
sudo systemctl reload mosquitto                          # keeps existing connections
```

### ⚠ Verify with MQTT v5, never 3.1.1

**A denied publish over MQTT 3.1.1 is silent.** The broker drops the message and
still returns a PUBACK, so `mosquitto_pub` reports `RC:0` for a publish that
never happened. Testing that way makes a broken ACL look like a working one -
it has now cost us twice.

Use `-V mqttv5`, where a denial is `RC:135`:

```bash
mosquitto_pub -h HOST -V mqttv5 -u greenhouse -P '...' -q 1 \
  -t tempestas/v1/node/elantris/gpio/set -m '{}' -d     # expect PUBACK RC:135
```

Check both directions. An ACL that denies everything also passes a
denial-only test.

## Still outstanding for greenhouse

- **Broker credentials on elantris.** Its mosquitto needs the `greenhouse` and
  `tempestas-observer` identities added, and the updated ACL installed. Until
  then greenhouse can authenticate with nobody.
- Nothing enabled. The agent and server are installed and disabled.

## When to update this file

- A box is provisioned, reflashed, or its OS changes
- The node, Postgres or broker layout on either box changes
- A unit gains or loses a dependency that differs between the boxes

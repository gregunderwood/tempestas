# Packages

## What it is

tempestas is installed with apt. Every box installs the same `.deb`s and gets new versions the same
way. So far there is one package, **`tempestas-agent`**, the Linux node agent. Still to come: the
server package, an apt repository on the LAN that every box installs from, and Linux nodes updating
through apt from the Nodes page.

Until that last one, a packaged node cannot be updated from the Nodes page. It refuses a bundle with
`failed`: "this agent was installed from a package, so it updates through apt, not a bundle".
elantris and patji still run the hand-deployed agent from
[Linux Agent, Deployment](Linux%20Agent.md#deployment) until they move onto the package.

## Key files

- [../../tools/build-agent-deb.sh](../../tools/build-agent-deb.sh) — builds `tempestas-agent_<version>_all.deb` from the checkout
- [../../tools/check-agent-deb.sh](../../tools/check-agent-deb.sh) — installs it in clean bookworm and trixie containers, then removes it
- [../../tools/lib/debian-version.sh](../../tools/lib/debian-version.sh) — an agent or product version as a Debian version
- [../../apps/agent-linux/packaging/](../../apps/agent-linux/packaging/) — the packaged unit and the install scripts
- [../../.github/workflows/gate.yml](../../.github/workflows/gate.yml) — builds and checks the package on every PR

## How it works

### Building it

```bash
tools/build-agent-deb.sh                 # dist/packages/tempestas-agent_<version>_all.deb
npx nx run agent-linux:package           # build, then install it on bookworm and trixie in Docker
```

It needs `uv` and `dpkg-deb`, which the laptop and the GitHub runners both have, so no packaging
tool is downloaded.

### What it installs

```
/usr/lib/tempestas/agent/tempestas_agent/          the agent, stamped with its version
/usr/lib/tempestas/agent/tools/                    scd4x_check.py and scd4x_frc.py
/usr/lib/tempestas/agent/vendor/                   paho-mqtt and smbus2
/usr/lib/systemd/system/tempestas-agent.service    the unit
/usr/share/doc/tempestas-agent/agent.example.toml  the config to start from
```

The install script creates the `tempestas` system user and adds it to `gpio` and `i2c` where the
board has them. It creates `/etc/tempestas` (`0750 root:tempestas`) only if it is missing, because
a leader's already holds `server.env` with its own owner and mode. It then enables and restarts the
unit.

- **The package never writes `agent.toml`.** Claiming relay lines stays a human edit. The unit has
  `ConditionPathExists` on both `agent.toml` and `agent.env`, so until both exist it is skipped, not
  failed, and the install still succeeds.
- **One package for every Pi.** It is `Architecture: all`, because paho-mqtt and smbus2 are pure
  Python and ride inside it, and the build fails if a vendored file is compiled. Bundling them is
  deliberate: bookworm's `python3-paho-mqtt` is 1.6, too old for the agent's 2.1, and trixie's
  smbus2 is below its floor. The pins come from `uv.lock`, as everywhere else.
- **`lgpio` comes from Debian.** It is compiled, so the package recommends `python3-lgpio`, and the
  unit runs the system `/usr/bin/python3` so it can import it.
- **Its version is the agent's own**, from
  [tools/describe-agent-version.sh](../../tools/describe-agent-version.sh), because that is what
  `hello` reports and what the server compares. The product version names the server and the
  release. A `-` becomes `~`, so a pre-release sorts below its release: `1.2.3~dev+96a677e` <
  `1.2.3`. A version dpkg would refuse fails the build.

### Installing it on a box

```bash
scp dist/packages/tempestas-agent_*_all.deb <host>:
ssh <host> sudo apt install ./tempestas-agent_*_all.deb
```

Then, on the box, write the config from the example and the broker credentials, and start it:

```bash
sudo install -m 0640 -o root -g tempestas /usr/share/doc/tempestas-agent/agent.example.toml /etc/tempestas/agent.toml
sudoedit /etc/tempestas/agent.toml        # node_id, broker URL, sensor; no lines until a human claims them
sudoedit /etc/tempestas/agent.env         # MQTT_USERNAME and MQTT_PASSWORD, mode 0600 root
sudo systemctl restart tempestas-agent
```

The broker account and its ACL are made on the leader, as
[Provisioning](Provisioning.md) describes.

## Pitfalls

- **A hand-installed unit in `/etc/systemd/system` overrides the package's.** elantris and patji
  have one. Moving them onto the package must remove it, or they keep running the hand-deployed
  agent.
- **The bench check runs no systemd.** The containers prove the install, the user, the imports and
  the removal. They do not start the unit; a real box does.
- **`gpio` and `i2c` are in the unit's `SupplementaryGroups`.** A box without those groups cannot
  start the agent. Every Pi has them.
- **Running Python as root leaves `__pycache__` beside the code.** The `prerm` removes it, so a
  removal leaves no directory behind.

## When to update this file

When a package is added, when what a package installs or where it installs it changes, or when the
way a box gets packages changes.

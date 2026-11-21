# The sandbox

Runs **what we plan to run on the real hardware**, on a laptop: two boxes, one
greenhouse, a real broker with the production ACL, and two Postgres instances.

```bash
tools/sandbox/up.sh      # broker, world, both servers, both agents
tools/sandbox/seed.sh    # zone, admit both nodes, create every device
tools/sandbox/down.sh
```

|            | leader                 | follower                 |
| ---------- | ---------------------- | ------------------------ |
| Box        | `elantris`             | `greenhouse`             |
| API        | http://127.0.0.1:7010  | http://127.0.0.1:7011    |
| Postgres   | `:5442`                | `:5443`                  |
| Sensor     | `entrance`             | `canopy`                 |
| Relays     | BCM 5                  | BCM 21, 20, 26, 16, 12   |

Shared world at http://127.0.0.1:7100/world. Ports avoid the everyday dev stack
(`tempestas-db` on 5433, the dev server on 7000).

## Why it is built this way

**One world, two agents.** `FakeHardwareService` replaces the MQTT driver inside
the server, so it never exercises the broker, the contract, retained state or
refusals - and it cannot express the thing that matters most here: elantris's
burner changing what greenhouse's canopy sensor reads. The world is therefore a
separate service both agents talk to.

**The production ACL file, not a copy.** `up.sh` points mosquitto at
`apps/broker/mosquitto/tempestas.acl`. A sandbox with looser rules would not
have caught the silent QoS-0 denial that bit us on the real broker.

**Two Postgres instances, not two schemas.** Per-box databases are the design.
Sharing one would make takeover look easier than it is - and note that the same
node has a *different UUID* in each database, which is what independent
databases actually means.

**Order matters.** `hello` is QoS 1 and not retained, so the servers must be
subscribed before any agent announces. `up.sh` waits for both APIs first.
Production self-heals because nodes persist in its database; a sandbox with a
fresh one would simply never discover them.

## What it proves today

- Both agents claim at failsafe, with **BCM 26 at 0** and the other four at 1,
  all six de-energised. Mixed polarity is handled per fixture.
- A fenced `gpio/set` from the leader energises the burner, and **both** sensors
  then track it, ~143 ppm apart.
- A follower refuses to command with `CONTROLLER_IS_FOLLOWER`, does not
  heartbeat, and registers no server LWT - while still ingesting every reading
  into its own database.

## Knobs

```bash
SPEED=120 tools/sandbox/up.sh        # sim minutes per real minute (default 60)
CO2=1450 TEMP=24 tools/sandbox/up.sh # starting air
WITH_SERVERS=0 tools/sandbox/up.sh   # agents + world only

curl -X POST localhost:7100/clock -d '{"speed":600}'
curl -X POST localhost:7100/clock -d '{"jump_minutes":420}'   # jump to a boundary

# Drive a node directly, without a server:
uv run python tools/sandbox/ctl.py elantris --pin 5 --level 0
```

## Do not move the run directory under a dotfile

`up.sh` stages into `tools/sandbox/run/`, deliberately not `.run/`. Express's
`res.sendFile` applies `dotfiles: 'ignore'` across the whole absolute path, so a
root under a dot directory makes every deep link 404 while `/` keeps working -
the static middleware serves that one with a root-relative path that has no dot
segment. The failure looks exactly like a server-side routing regression.

## Known gaps

`apps/sim/greenhouse-model.json` carries provenance on every constant and a
`known_gaps` section. The big one: duty cycle is 29% simulated against 44%
measured. The period is right; the split is not. Fan and lights constants are
estimates - neither has ever run under tempestas.

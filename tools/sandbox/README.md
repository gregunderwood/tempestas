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

## How the world models the air

`apps/sim` is pure arithmetic behind a standard-library HTTP server, with no
dependencies, so it runs anywhere an agent does.

- **A line nobody has written is unknown, not off**, the same rule the real
  backends follow. Assuming off would let the sandbox pass a test that real
  hardware fails.
- **Polarity is per fixture.** Four channels are active-LOW and BCM 26 is
  active-HIGH; getting that backwards is the migration bug that lights a lamp.
  Two lines drive nothing, so a command routed to a dead channel is reproduced too.
- **Burner CO2 passes through an in-flight reservoir** that drains to the
  measured air with a time constant. A threshold-style warm-up would model only
  the rising edge and stop the burner dead on command; the greenhouse overshot
  the 1500 ppm cut-off by 46-103 ppm on every one of the four cycles measured.
- **The CO2 gradient between sites scales with enrichment.** A flat ±72 ppm
  offset is only valid near the ~1110 ppm it was measured at; applied at rest it
  put the canopy at 348 ppm, below outdoor air.
- **Humidity is carried as vapour pressure, not RH.** Two sensors in one air at
  different indicated temperatures must report different RH; the paired sample
  read 64.9% and 52.4% RH at 16.08 and 16.48 hPa.
- **Sim time runs faster than real time** so day/night segments and DST
  boundaries are reachable in a test. A single advance is capped at four hours,
  so a laptop waking from sleep does not integrate the night in one step.

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

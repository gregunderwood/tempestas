# Safety

## What it is

The CO2 generator is a **propane burner**, and it is also the greenhouse's **night heater**. That
single fact is why this document exists and why it is the first link in [AGENTS.md](../AGENTS.md):
failing it off is not the safe default, so "when in doubt, turn everything off" — the reflex that
works for most control systems — can kill a crop here.

Everything below is a decided policy, not a suggestion. If a change requires breaking one of these,
say so out loud and get it confirmed; do not quietly relax it.

## The four rules that get broken by accident

### 1. Commands are never retained

A retained `gpio/set` replays on **every reconnect** of a node that may be running a combustion
burner. State and status are retained; commands are transient.

⚠ **The retain flag does not enforce this on its own.** MQTT sets it on a delivered message only
when that delivery is caused by a new subscription, so a retained command published while everyone
is already connected arrives looking entirely legitimate — verified against a real broker in phase
7, where the node obeyed it and the message stayed on the bus to replay later.

The layer that works is **ownership**: the server is the only legitimate publisher of a command, so
anything else is `CONTROLLER_CONFLICT`. The server logs it at ERROR and **clears the retained slot**.
Delivery itself is stopped only by broker ACLs (phase 12), and a node must refuse a foreign
`issuedBy` (phase 8). `expiresAt` and `cleanStart` remain as the other two layers.

The full layering and the obligations it puts on a node are in
[MQTT Contract](Infrastructure/MQTT%20Contract.md#the-retained-command-trap).

Encoded in [../libs/domain/src/lib/hardware/mqtt-contract.ts](../libs/domain/src/lib/hardware/mqtt-contract.ts)
as `mqttQos`, so it cannot drift into folklore.

### 1b. A clean disconnect fires no will

MQTT **suppresses the last will on a graceful DISCONNECT**. The LWT therefore covers a crash, a
kill, or a network drop — and not an orderly shutdown. Anything that stops cleanly must publish its
own retained `status: offline` first, or it is left looking online forever while nothing is driving
its pins. The server does this in `onModuleDestroy`; every node must do the same.

Found by testing: a virtual node calling `client.end()` fired no will at all, and the registry went
on reporting it as online.

### 2. Stale is not off

When a node's LWT fires, its pins become **`unknown`**, not `0`. Only a fresh retained
`gpio/state` or a successful sync restores known state, and the UI renders unknown distinctly.
An "assume off" default is how a UI ends up confidently showing a burner as idle while it burns.

### 3. Publish first, persist only on success

```ts
await this.hardware.setPin(device.node.slug, { pin, level, label }); // rejects on readback mismatch
device.onAt = now; // only now
await this.devices.save(device);
```

The old system did the reverse: a failed GPIO write was logged and the row updated anyway, so the
database silently drifted from the hardware and the UI showed a heater as running when it was not.
`DevicesService.drive()` is the single choke point — every path (`turnOn`, `forceOn`, `turnOff`,
and the rules engine) funnels through it.

### 4. A null CO2 means unknown, never zero

The node reports validity honestly and **never substitutes a last-known-good value**. A null
coerces to `+Infinity` downstream, so the daytime enrichment branch stays off. A dead sensor stuck
on a low reading would otherwise run the burner indefinitely on a phantom "CO2 is low".

The night heating branch never reads CO2 at all, so a dead CO2 sensor must not affect it.

## The admission gate

An unknown node that publishes `hello` becomes a **`pending`** row. While pending the server sends
it no commands and **discards** its readings. Admission is one click.

The reason is blunt: a stray ESP32 on the WiFi must not be able to inject a temperature reading
that starts a combustion burner. Paired with **per-node Mosquitto credentials and ACLs** restricting
each node to `tempestas/v1/node/{its own slug}/#` — any MQTT client can otherwise publish as any
node. Neither layer is optional once something other than a Pi is on the network.

Full lifecycle in [Infrastructure/Nodes.md](Infrastructure/Nodes.md).

## The boot-window hazard

⚠ **This is the most dangerous property of the physical build and it is not yet mitigated.**

BCM 9–27 default to **pull-down** on the BCM2711. Four of the five relays are **active-LOW**:

| Device            | BCM | polarity    | level when unclaimed | relay when unclaimed |
| ----------------- | --- | ----------- | -------------------- | -------------------- |
| Extra Relay       | 12  | active-LOW  | LOW                  | **ON**               |
| **CO2 Generator** | 16  | active-LOW  | LOW                  | **ON**               |
| Exhaust Fan       | 20  | active-LOW  | LOW                  | **ON**               |
| Lights            | 21  | active-LOW  | LOW                  | **ON**               |
| Single Light      | 26  | active-HIGH | LOW                  | OFF                  |

A line is unclaimed during the **entire boot window**, **every crash-restart gap**, after any
`gpio_free()`, and **forever if the agent fails to start**. In all of those windows a gas burner is
being commanded on with nothing supervising it.

The old system has run a year like this. The likely reason nothing happened is that the relay board
has its own input pull-up — **but nobody has measured it.** Measuring it is a gating step.

Three mitigations, all required, because each covers a window the others do not:

1. **Firmware** — `gpio=12,16,20,21=op,dh` and `gpio=26=op,dl` in `/boot/firmware/config.txt`.
   VideoCore applies this ~1 s after power-on, before the kernel. Closes the boot window.
2. **Hardware** — external 10 kΩ pull-ups to 3V3 on each active-low relay input. The only
   mitigation that works when no software is running.
3. **Software** — claim each line with a bias pulling toward its **declared failsafe level**
   (`SET_PULL_UP` for an active-low relay), not `SET_PULL_NONE`. The internal ~50 kΩ pull-up is
   ~66 µA, too weak to trust against an opto-isolator input on its own, but the bias survives both
   a release and a kill, so it is the state the pad settles into once no software is left to have
   an opinion.

> [!important] What a released line actually does, measured
> The assumption above used to be that **after `gpio_free()` the pad reverts to input**. On this
> kernel it does not. Measured on elantris with `pinctrl get`: `gpio_free()`, and a `SIGKILL` of
> the whole process, both leave the pad an **output still driving its last level**, with the bias
> intact. It does not float and it does not revert.
>
> That cuts both ways. A process killed at the safe level holds the safe level — better than
> assumed. A process killed with a burner energised holds **that**, indefinitely, with nothing
> supervising it and the node-side dead-man dead along with the process. The cover is systemd
> restarting the agent, whose claim then drives the failsafe; the exposure is the restart delay.
>
> Two consequences, both already in the code: claim at the **failsafe** level rather than trying to
> preserve state across a restart, and rely on the server's level-triggered re-assert to bring a
> legitimately-running burner back. The old system's `gpio_free()` hazard was real but had a
> different mechanism — `RPi.GPIO.cleanup()` explicitly sets pins back to input, which the chardev
> path does not.

Two related deletions, both carried from the old system:

- **Never call `gpio_free()` on shutdown.** Freeing the line energises the burner.
- **Delete the boot-time relay click test.** It energises a gas burner at every boot, defeats the
  300 s anti-short-cycle protection, and combined with `Restart=always` and a crash loop becomes
  repeated ignition attempts. It also proves little — a readback verifies the GPIO pad, not the
  relay coil. Replace it with an on-demand `gpio-click <pin>` that refuses hazardous lines by
  default. Same for the old readiness test that claims and writes **BCM 18**, an unmanaged pin.

## Three layers of run-time protection

They are separate because they fail independently.

### Layer 1 — server side, stale sensor

If readings stop arriving, the rules engine **holds last state**, logs at ERROR, sets
`systemStatus.sensorStale`, and the Angular app shows a loud, persistent banner.

Neither automatic alternative is safe: failing everything off can freeze the greenhouse, forcing
heat on can cook it. A human decides. **This is only sound if the alarm is actually visible** — the
banner is a required part of the feature, not a nice-to-have.

The mechanism is the `system:status` socket event, whose `sensorStale` flag raises it; the last
status is cached and replayed to a connecting browser so the banner never waits for the next tick.
See [Realtime](Infrastructure/Realtime.md). `GET /api/health` reports the same condition for
anything that is not a browser.

### Layer 2 — node side, dead-man

Each node enforces its own timeout locally, with no server involvement, so it works when the brain
is gone entirely. It belongs in the MQTT contract as a **required node behaviour**, not a
convention — a Pi sidecar and an ESP32 must both implement it. Safe state is per device class:

| Device class  | On loss of commands              | Why                                                                                  |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| CO2 generator | long hold at night, short by day | It is _also_ the night heater                                                        |
| Exhaust fan   | OFF                              | Benign either way; off is the quiet default                                          |
| Lights        | brief hold, then OFF             | A blip shouldn't kill a heat-contributing light, but nothing runs unattended forever |

The burner wears two hats. By day it is enrichment and failing it off costs nothing; by night it is
the heat source and failing it off on a cold night is how plants die. The dead-man cannot tell which
mode it is in without the brain that just died — but it _can_ read a clock, so it applies the same
night window locally and holds longer at night before dropping the line.

**Open question:** how long is that night hold? Long enough to ride out a restart or a WiFi blip,
short enough that a dead controller doesn't leave it burning until morning. It gets much easier to
answer if independent backup heat exists — see [Roadmap](Roadmap.md).

### Layer 3 — bounded run-time on the burner

- **No CO2 concentration ceiling.** The 4-burner generator cannot over-enrich this greenhouse: it
  leaks enough that CO2 has never exceeded ~2500 ppm and rarely passes 2000 (the 8-hour
  occupational limit is 5000). More importantly the night rule deliberately ignores CO2, so a
  concentration cutoff would fight it and shut the heat off on a cold night. High CO2 at night is
  expected and fine.
- **No duty-cycle cap.** A long continuous burn on a cold night is legitimate behaviour, not a fault.
- **A no-progress check instead.** If the burner has run continuously for a long window and the
  temperature has not risen at all, something is wrong — stale sensor, burner not lighting, door
  left open. Alarm and surface it; do not silently cut the heat.

The residual combustion concern is **CO from incomplete combustion**, not CO2 — a different gas with
a limit three orders of magnitude lower. A CO alarm in the greenhouse is cheap and independent of
all of this. Worth having; nothing in this repo can enforce it.

## Single ownership of the GPIO chip

Four layers, because a second writer on one line is the failure that produces impossible states:

1. **systemd is the only supervisor** — `Restart=on-failure` with a start limit, never the old
   unlimited `Restart=always`.

   ⚠ `StartLimitIntervalSec` and `StartLimitBurst` belong in **`[Unit]`**, not `[Service]`. Under
   `[Service]` systemd logs `Unknown key` and silently falls back to the 10 s default — the unit
   shipped that way and the limit was never in effect. `systemd-analyze verify` catches it;
   `systemctl show -p StartLimitIntervalUSec` confirms what is actually applied.

2. An advisory **`flock` on `/run/tempestas/agent-<node>.lock`** taken before the backends are built
   and therefore before the chip is opened. Per node id, because that is the thing two agents
   actually collide over.

   It does **not** cover the bench tool: `tools/relay-check.py` takes no lock. That is deliberate —
   layer 3 below refuses it at the kernel, which is a stronger guarantee than an advisory lock two
   programs have to agree to honour, and the tool prints the refusal plainly. Verified against the
   live service.

3. **The kernel** — `gpio_claim_output` on a claimed line returns `GPIO busy`. This is the layer
   that actually enforces it, and it is the one that cannot be bypassed.
4. A **startup preflight** that refuses to start if any managed line is held by another consumer,
   naming it. Note what this layer is and is not: `gpio_get_line_info` reports another **userspace**
   holder (measured — a second process shows `user='lg'`), and reports **nothing** for a line owned
   by a kernel driver — BCM 2 and 3 are the live I²C bus and still read as free. So the preflight
   buys a better error message, not the guarantee; layer 3 is the guarantee.

And a hard rule for the Python venv: **never install `RPi.GPIO`, `rpi-lgpio` or `gpiozero`.**
`rpi-lgpio` shims the RPi.GPIO API onto lgpio via a _different_ handle and will fight ours for the
same lines — exactly the live defect in the old `device_health_check.py`, which still imports
`RPi.GPIO` with no `setmode` and was missed by the lgpio migration. Making it impossible beats
remembering.

## Level-triggered, not edge-triggered

The node re-asserts the **full desired state of every line** on a 5 s heartbeat rather than sending
one-shot toggles. Any missed message self-heals on the next tick. This is what eliminates both the
old system's 43k loopback POSTs a day _and_ its silent DB↔hardware divergence.

Guard rail: only one controller may hold the heartbeat. Starting the Mac's NestJS must stop the
Pi's, or bump the controller `epoch` to take over cleanly. Bake that handover into one script so it
cannot be half-done.

## Authentication is an interlock, not security

LAN-only on a home network. No accounts, no JWT — disproportionate, and the kind of thing that
locks you out of your own greenhouse at 2 a.m. In priority order:

1. **Secure Mosquitto first.** ✅ **Done (2026-09-09).** This is the real attack surface: an MQTT
   write goes straight to a GPIO pin and a propane burner, bypassing any HTTP control. Everything
   below matters less than this line.

   The posture, in [../apps/hardware/mosquitto/](../apps/hardware/mosquitto/): `allow_anonymous false`,
   a listener bound by **interface** (`bind_interface wlan0`, not a hardcoded address — this box is
   on DHCP and a lease change would otherwise stop the broker), an explicit loopback listener
   alongside it, and three identities scoped by ACL.

   ⚠ **The Mosquitto 2.x trap:** shipping no `listener` directive gives you a local-only listener
   that also **allows anonymous connections**. Adding a listener to reach the LAN silently inherits
   that. `allow_anonymous false` has to land in the same change, not afterwards.

   | Identity             | May publish                                | May read               | Why                                                                           |
   | -------------------- | ------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------- |
   | `tempestas-server`   | commands, heartbeat, its own status        | every node's telemetry | The only legitimate publisher of a command                                    |
   | `elantris`           | **only its own** subtree, never `gpio/set` | its own commands       | A node that could command itself makes the controller's ownership meaningless |
   | `tempestas-observer` | **nothing**                                | the whole tree         | The node credential cannot read its own samples, so a logger cannot borrow it |

   Authentication says who a client is; only the ACL says whose relays it may command. Both halves
   were verified against the live broker with QoS-1 publishes, since **a denied QoS-0 publish is
   silent** and looks exactly like success — check for `PUBACK RC:135`, do not infer from no error.

2. **No WAN port-forward.** If remote access is wanted, Tailscale/WireGuard — not authentication.
3. **One shared token on mutating verbs only** (`X-Tempestas-Token` on POST/PUT/PATCH/DELETE
   including `/on`, `/off`, `/force-on`). GETs stay open so a phone dashboard is frictionless. The
   realistic threat is not an attacker; it is a guest device or a stale browser tab turning on a
   CO2 generator.
4. **Keep the global throttler.** It protects against a runaway client loop, which is the failure
   that actually happens on a home LAN.

## The transition interaction

During the side-by-side period the legacy Flask app runs the exhaust fan on its own thresholds while
tempestas runs the burner. Neither knows the other exists, and no cross-system interlock is possible
in software.

This is a **waste-and-control problem, not a safety one**: burner on while the vent is open means
gas burned straight out the vent and a setpoint never reached. Annoying and expensive rather than
dangerous, since the greenhouse's leakiness is what keeps concentrations low in the first place. It
matters more at night, when the fan would be fighting the heat — though in practice the thresholds
barely overlap (fan at 30 °C, night heat below 3 °C).

Mitigation: add the legacy system as a `kind: 'virtual'` node — an HTTP poller hits the legacy
`GET /devices` every 30 s and records exhaust-fan state as node `greenhouse-legacy`. The dashboard
then shows vent state beside burner state, and the burner rule can gain a cross-system
precondition. It also stress-tests the node abstraction against a node that speaks no MQTT at all.

## Pitfalls

- **The OOM killer is a safety hazard on this box.** It can take out the burner controller. Set
  `OOMScoreAdjust=-900` and `MemoryMin=64M` on the sidecar unit, `-500` on Postgres and Mosquitto —
  and never run an Angular dev server or a production build on the Pi.
- **`LOGLEVEL=DEBUG` must not be permanently settable.** Expose it as a command with a mandatory
  duration that auto-reverts. The old system's 5.4 GB debug log is what a permanently settable flag
  produces.
- **A hardware watchdog is on** (`/dev/watchdog` is present) so a kernel hang reboots into the
  firmware's safe GPIO defaults — which is only safe once mitigation 1 above is in place.

## When to update this file

- A new failure mode is discovered, or a mitigation is actually implemented (move it out of
  "not yet mitigated")
- The dead-man timings are decided
- A device's polarity or pin assignment changes
- The auth posture changes, or the system stops being LAN-only

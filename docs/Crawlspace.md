# Crawlspace

## What it is

Freeze protection under the house: a heater and a heat tape, driven by `braize`, a Pico W running
the [Pico Agent](Infrastructure/Pico%20Agent.md). It copies the [Pumphouse](Pumphouse.md)
posture: a dead node, a lost link or a dead probe all end in heat.

⚠ Read [Safety](Safety.md) before wiring or energising anything.

> [!note] Status
> Planned. The agent, the zone script and the broker ACL are written; nothing is installed. The
> heater waits for its contactor.

## Decisions already made

| Decision  | Value                                                                               |
| --------- | ----------------------------------------------------------------------------------- |
| Names     | Node `braize`, kind `pico`; zone `crawlspace`, `America/Vancouver`                  |
| Setpoints | The pumphouse's: tape on below 4 °C, off above 6; heater on below 2 °C, off above 5 |
| Stale     | `onStale: 'on'` for both, `maxAgeMs` 120 s, sensor policy `min`                     |
| Probes    | One for now, `air` (`28-3ce1d4436ee8`)                                              |
| Power     | A GFCI outlet in the crawlspace for the loads; a USB adapter for the Pico           |

## Hardware

| Load      | Relay | Pico pin | Wiring                                                                                          |
| --------- | ----- | -------- | ----------------------------------------------------------------------------------------------- |
| Heater    | K1    | GP20     | K1's COM/NC switches the 120 VAC coil of a JQX-62F-2Z contactor; its NO poles switch the heater |
| Heat tape | K2    | GP18     | Directly on K2's NC terminal                                                                    |

The heater is about 750 W on low, too much for a constant load on a 10 A Songle relay, and
1,500 W on high is over its rating, so it goes through a contactor as on patji. With the coil on
K1's NC side, a released relay energises the coil and the heater runs.

### What each failure does

| Failure                                      | Tape and heater          |
| -------------------------------------------- | ------------------------ |
| Pico unpowered, resetting or hung (watchdog) | ON (NC wiring)           |
| Wi-Fi drop, or elantris unreachable          | hold for 10 min, then ON |
| `tempestas-server` stops                     | ON at once               |
| Probe dead                                   | ON after `maxAgeMs`      |
| Everything fine                              | thermostat rules         |

## The install, in order

### 1. Server and migration

The node kind `pico` is a Postgres enum value. **Migrate before braize first connects**, or the
server cannot store its `hello`.

```bash
tools/deploy.sh                                   # patji fails safe for ~8 s during the restart
ssh elantris
pg_dump -Fc tempestas > ~/backups/tempestas-$(date +%F)-before-pico.dump
cd ~/tempestas && npm run migration:show          # only AddPicoNodeKind pending
npm run migration:run
```

### 2. Broker account

The `braize` block is in [tempestas.acl](../apps/hardware/mosquitto/tempestas.acl). Install the
file and create the password on elantris, per
[Provisioning](Infrastructure/Provisioning.md#-broker-credentials-generate-the-hash-on-the-broker):

```bash
sudo cp ~/tempestas/apps/hardware/mosquitto/tempestas.acl /etc/mosquitto/tempestas.acl
sudo mosquitto_passwd -b /etc/mosquitto/tempestas.passwd braize '<password>'
sudo chown mosquitto:mosquitto /etc/mosquitto/tempestas.passwd /etc/mosquitto/tempestas.acl
sudo chmod 0600 /etc/mosquitto/tempestas.passwd /etc/mosquitto/tempestas.acl
sudo systemctl reload mosquitto
tail /var/log/mosquitto/mosquitto.log             # no ownership warnings; server and patji back
```

Verify with MQTT v5 in both directions:

```bash
mosquitto_pub -h 192.168.2.70 -V mqttv5 -u braize -P '...' -q 1 \
  -t tempestas/v1/node/braize/alarm -m '{}' -d        # expect RC:0
mosquitto_pub -h 192.168.2.70 -V mqttv5 -u braize -P '...' -q 1 \
  -t tempestas/v1/node/patji/alarm -m '{}' -d         # expect RC:135
mosquitto_pub -h 192.168.2.70 -V mqttv5 -u braize -P '...' -q 1 \
  -t tempestas/v1/node/braize/gpio/set -m '{}' -d     # expect RC:135
```

### 3. Flash and deploy the Pico

Follow [Installing](Infrastructure/Pico%20Agent.md#installing): update MicroPython, remove the
old tutorial scripts, write `credentials.py` with the password from step 2, then
`tools/deploy-pico.sh`. Expect Wi-Fi, the clock set, a broker connection, and `braize` in
`GET /api/nodes` as `pending`.

### 4. Zone, admission, devices

```bash
sudo -u postgres psql -d tempestas -v ON_ERROR_STOP=1 -f tools/crawlspace-zone.sql
curl -s http://192.168.2.70:7000/api/health          # the zone is not in `problems`

API=http://192.168.2.70:7000/api
NODE_UUID=$(curl -s $API/nodes | jq -r '.[] | select(.slug == "braize") | .id')
ZONE_UUID=$(curl -s $API/zones | jq -r '.[] | select(.slug == "crawlspace") | .id')
curl -s -X POST $API/nodes/$NODE_UUID/admit -H 'Content-Type: application/json' \
  -d "{\"zoneId\": \"$ZONE_UUID\", \"displayName\": \"Braize\", \"location\": \"Crawlspace\"}"
```

Devices, **both `onLevel` 1** because both hang off NC:

| Name      | GPIO | onLevel | onDelayDuration | role        |
| --------- | ---- | ------- | --------------- | ----------- |
| Heater    | 20   | **1**   | 300             | `heater`    |
| Heat tape | 18   | **1**   | 60              | `heat_tape` |

```bash
curl -s -X POST $API/devices -H 'Content-Type: application/json' -d "{\"nodeId\": \"braize\",
  \"zoneId\": \"$ZONE_UUID\", \"name\": \"Heater\", \"gpio\": 20, \"onLevel\": 1,
  \"onDelayDuration\": 300, \"role\": \"heater\", \"rulesEnabled\": true}"
curl -s -X POST $API/devices -H 'Content-Type: application/json' -d "{\"nodeId\": \"braize\",
  \"zoneId\": \"$ZONE_UUID\", \"name\": \"Heat tape\", \"gpio\": 18, \"onLevel\": 1,
  \"onDelayDuration\": 60, \"role\": \"heat_tape\", \"rulesEnabled\": true}"
```

### 5. Bench test, before it goes under the house

A lamp stands in for each load. Start with both commanded **off** (probe warm), so every failure
shows as lamps coming on:

- [ ] The probe reports as `air`, and the node is admitted
- [ ] Each relay switches from the API, and the cooldown refuses an early restart
- [ ] Each relay switches from the rule, with the probe in ice water
- [ ] Unpower the Pico: both lamps on
- [ ] Ctrl-C the agent over USB: the watchdog resets it within ~8 s, both on, then back under rule control
- [ ] Block braize from the broker (firewall rule on elantris): nothing for 10 min, then both on,
      and the server re-asserts when unblocked
- [ ] Stop `tempestas-server`: both on at once, back under rule control when it returns
- [ ] Unplug the probe: `stale-failsafe` within `maxAgeMs`, both on, banner up
- [ ] Reboot with NTP unreachable: commands refused until the clock is set, then the rule takes over
- [ ] Cold boot: no chatter through the boot grace, then the rule takes over

### 6. Install

The heat tape can go live as soon as the bench passes; the heater waits for the contactor and an
enclosure. Confirm the GFCI trips and resets with both loads on it, then watch a day of Wi-Fi
under the floor before trusting it.

## Open questions

- Where the probe sits: near the coldest pipe, or in the air?
- A second probe, once the first winter shows where the cold spot is.
- The enclosure for the Pico, the relay board and the contactor.

## When to update this file

- A setpoint, the zone or a device changes
- The wiring or the contactor changes
- A bench item is done or a new failure mode is found

# Planner

## What it is

The direction tempestas is growing in: from a controller for one greenhouse into a platform that
takes a grower **from an idea to a running system**. A grower describes what they want to grow and
where, captures the space with a phone, gets a model of it, places simulated equipment, sees whether
that equipment would hold the climate their crop needs, gets a bill of materials and a build guide,
builds it, and commissions it into a live tempestas.

The audience is **other growers**, from a hobbyist with a tent in the basement to a commercial
multi-bay project, and the space is **any controlled environment**: greenhouses, grow rooms, tents,
shipping containers, vertical farms, mushroom fruiting chambers, curing rooms.

> [!note] Status
> Vision, not built. Nothing on this page exists in the code yet. The decisions that are expensive
> to reverse are recorded in [Decisions](#decisions); everything else here is direction, and is
> expected to change as each step is built and learned from.

> [!warning] The controller stays what it is
> None of this relaxes [Safety](Safety.md). A plan's simulated devices never share a rules engine
> with a live relay, and the hosted service never commands anything. See
> [0001](Decisions/0001%20Hosted%20never%20commands.md).

## The lifecycle

**Envision → Plan → Simulate → Source → Build → Commission → Operate → Learn**

What exists today is _Operate_. The central idea is that **the plan and the live system are the same
model at different stages**. A planned device and an installed device are one entity with a
lifecycle state, not two systems that have to be reconciled. Commissioning is the moment a planned
device's state becomes installed, and a finished plan becomes the live policy without being
translated.

| Stage      | The grower                                             | Tempestas                                                                 |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Envision   | Says what they want to grow, where, and on what budget | Turns crops and location into climate requirements                        |
| Plan       | Captures the space; places equipment                   | Builds a parametric model; checks sizing and allocation as they place     |
| Simulate   | Asks "what if"                                         | Runs the plan's rules against a year of weather and against failures      |
| Source     | Picks a good, better or best option                    | Produces a bill of materials, by region, with sources                     |
| Build      | Follows a guide on their phone                         | Step-by-step guides and wiring diagrams, gated by who should do the work  |
| Commission | Plugs things in                                        | Matches each announcing node and device to its planned entry; verifies it |
| Operate    | Grows                                                  | The controller as it is today                                             |
| Learn      | Opts in                                                | Calibrates the models from what real installations actually did           |

## Start from intent, not hardware

A hobbyist does not know they need a 50-pint dehumidifier. They know they want tomatoes in winter.
So the first input is intent:

- **Crops and their stages**, each with a profile: temperature, humidity or VPD, CO2, daily light
  integral, photoperiod.
- **Location**, which brings the climate, mains voltage, plug standard, suppliers and building
  codes.
- **Budget, and how much they want automated.**

From those the planner derives **requirements**: heating and cooling loads, moisture to remove,
light and CO2 to add. What dominates depends on the space, and the model has to get both right:

- A **greenhouse** is dominated by heat loss through glazing and by the sun.
- A **sealed grow room** is dominated by the heat of its lights and by transpiration — water in
  equals water out — so dehumidification and cooling size the system.

## The spatial model

A **site** holds **spaces**, and spaces nest: a tent inside a basement, a grow room inside a house,
a bay inside a multi-bay greenhouse.

- A space comes from a **parametric template** — hoop, gable, Venlo, lean-to, tent, room,
  container — and is described by a handful of dimensions. The model is the parameters; the browser
  builds the geometry. There is no mesh to store, and because the geometry was generated, every
  face already knows whether it is roof, wall or glazing.
- Spaces hold **interior elements**: benches, racks, vertical tiers.
- Every **boundary** records its material and **what is on the other side**: outdoor air, ground,
  or another conditioned space. A wall shared with a heated house behaves nothing like one facing a
  January night.
- **Placements** give planned and installed equipment a position and orientation in metres, in the
  site's documented coordinate system.
- **Zones keep their existing meaning** — an airspace that owns rules (see
  [Architecture](Architecture.md)). A plan says which spaces make up each zone; a space is not a
  zone.

Photogrammetry and scanning are deliberately not the main path. Glass, reflections and repeated
framing are its worst case, and a greenhouse is all three. It can come later as an optional worker
for irregular spaces, producing a reference mesh beside the parametric model, never instead of it.

## Capture

Capture has to be easy at both ends of the audience.

- **Hobbyist:** photos, a video walkthrough, and a sentence — _"4×4 tent in my basement"_. A vision
  model drafts the template, dimensions and materials, and the grower corrects the draft. Photos
  and notes attach to the parts of the model they show.
- **Commercial:** import the drawings they already have — DXF, IFC, a PDF floor plan. Commercial
  projects start from drawings, not phone photos.
- **Without AI:** a guided wizard — pick a shape, enter its dimensions. It is always available, and
  it is the whole of capture when no model provider is configured.

The firm rule: **a language model proposes and explains; a deterministic engine does the
arithmetic.** No heater is ever sized by a language model.

Original media is kept as captured. Anything derived from it is a separate, versioned asset.
Capture media is sensitive — see [0005](Decisions/0005%20Capture%20media%20is%20sensitive.md).

## The catalog

Everything after the model depends on a catalog of equipment. An entry carries:

- capabilities, and the protocols it speaks
- electrical specification: voltage, current, inrush, relay rating where it switches a load
- physical specification, where it affects placement
- certifications — UL, CSA, CE — which commercial projects require
- sourcing and price bands per region, each dated
- the **driver** that runs it, and which agent kinds can host that driver

Above entries sit **build recipes**: reusable kits such as _"Pico W + SCD41 sensor pod"_, each with
its bill of materials, wiring, a printable enclosure and the firmware step.

The catalog is **versioned, schema-validated data**, contributed through pull requests by the
community and later by vendors. It needs its own data licence, separate from the code's.
It is seeded with the hardware tempestas already runs, and [Hardware](Hardware.md),
[Off-the-shelf devices](Infrastructure/Off-the-shelf%20devices.md), [Pumphouse](Pumphouse.md) and
[Crawlspace](Crawlspace.md) are most of that content already.

## Drivers and agents as supported hardware grows

The set of supported hardware will keep growing, and that puts pressure on the agents. The direction
is that **an agent becomes a host for driver plug-ins** rather than one program that knows every
device:

- drivers per bus or protocol: I2C, 1-Wire, Modbus RTU and TCP, Zigbee, BLE, 0–10 V dimming,
  4–20 mA
- each driver declares its capabilities, which keeps the existing principle that adding hardware is
  data, not code — NestJS still never branches on node kind
- agent kinds by resource class: microcontroller, Linux node, protocol gateway, and an industrial
  bridge to the PLCs and building management systems that commercial sites already run

This turns part of planning into an **allocation problem**, and the planner can solve it at design
time instead of at the bench: assign planned devices to nodes and check the limits — I2C address
clashes (two SCD41s both answer at `0x62`, so a multiplexer joins the bill of materials), GPIO count,
MicroPython memory, power budget, Wi-Fi coverage.

At commercial scale — hundreds of sensors, many zones — the MQTT topic layout and the history store
will need revisiting. Not yet.

## Simulation

Cheapest first, each level useful on its own:

1. **Steady-state sizing**, instant, on every placement: heat loss from area × U-value × design
   temperature difference; air changes per hour from fan flow and volume; relay rating against load;
   amps per circuit; sensor placement against what the plants actually see.
2. **Time-stepped**: a lumped heat and moisture model per zone, driven by a typical weather year for
   the location, with sun position and glazing transmission for daily light by month. **The plan's
   rules run in the same rules engine that will run them live**, against simulated devices behind the
   existing fake hardware seam.
3. **Failure scenarios**: _"the heater fails on the design night — 3 h 40 min to frost."_ Time to
   damage tells a grower whether they need a second heater, an alarm, or an off-system thermostat.
4. **Airflow and uniformity**, for commercial projects, much later.

Simulation always runs in a planning sandbox. It is never mixed into a live site.

## Output, by audience

- **Hobbyist:** a bill of materials with sources, a wiring diagram per node, step-by-step build
  guides, flashing and provisioning instructions.
- **Commercial:** a specification for contractors — equipment schedule, I/O points list, control
  sequence narrative. A commercial grower hires an electrician; they do not follow a DIY guide.

Safety gating scales with the audience:

- Mains and gas work is marked as needing a licensed electrician or gas fitter, by region.
- Off-the-shelf switched outlets are preferred over DIY mains relays.
- Every plan with a heater includes an off-system fail-safe thermostat by default — the lesson of
  [Roadmap](Roadmap.md) Stage A, offered to everyone.

## Commissioning

A phone build mode gives a checklist per step. Verification steps use the live system:

- plug in the sensor, and its planned entry turns green when the node announces it
- drive the relay, and readback confirms its `onLevel`

This is the existing admission flow — **discovery proposes, a human adopts** (see
[Multi-Controller](Multi-Controller.md)) — with the plan supplying what each proposal should match.
When the last item is verified, the plan is the live configuration.

## Hosted and self-hosted

Both are supported from the same code. The rule that makes it work is **hosted helps you plan; local
runs your site.**

| Profile                    | Who                                      | Plan         | Operate                               |
| -------------------------- | ---------------------------------------- | ------------ | ------------------------------------- |
| Hosted plan, local control | Most hobbyists                           | Hosted       | Their own nodes                       |
| Fully self-hosted          | Tinkerers, privacy-sensitive, commercial | Their server | Their own nodes                       |
| Hosted plus fleet          | Commercial, multi-site                   | Hosted       | Local, with remote view and analytics |

Hosted is **shared tenancy**: every organisation in one deployment, each reached at its own
subdomain, `<tenant>.<hosted domain>`. A tenant can bring their own domain, by a CNAME or by
delegating it to our nameservers. Self-hosted runs the same image with one organisation, either in
the grower's own cloud account under their domain, or on their LAN — still under a real domain name
with a real certificate, because a phone only gives a page its camera over HTTPS. See
[0004](Decisions/0004%20Tenancy%20from%20the%20first%20migration.md) and
[0006](Decisions/0006%20Every%20deployment%20is%20reached%20by%20its%20own%20domain.md).

What differs between them sits behind ports, the same way hardware sits behind `HardwareService`:
model provider, media storage, job queue, weather data, catalog distribution, identity. See
[0003](Decisions/0003%20Deployment%20differences%20sit%20behind%20ports.md).

What costs money when hosted is model calls and simulation jobs, so both are metered per
organisation from the start. A limited free tier for hobbyists and a paid commercial tier follow
from that.

AGPL-3.0 with a commercial option fits: anyone may self-host; anyone offering a modified copy as a
service publishes their changes or takes the commercial licence.

The planner runs on a desktop or a small server, needs no GPU, and **never runs on a node Pi**.

## Learn

Installations that opt in share anonymised operating data, which calibrates the models: how much
heat a polycarbonate gable in a given climate zone actually loses, against what was predicted. Every
plan gets better. It is opt-in, and a self-hosted site loses nothing by declining.

## Build order

Think big, build small. Every step ends in something a grower can use.

| Step | Delivers                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The domain model — site, spaces, zones, placements, planned and installed devices — and the catalog schema, seeded with the hardware tempestas already runs |
| 1    | Templates and a 3D view; placing catalog items; steady-state sizing; a bill of materials — for **a greenhouse and a grow tent**, to prove it generalises    |
| 2    | Crop-driven requirements, and an equipment recommender offering good, better and best                                                                       |
| 3    | Time-stepped simulation with weather, and failure scenarios                                                                                                 |
| 4    | AI-assisted capture from photos, video and descriptions                                                                                                     |
| 5    | Build mode, and commissioning into a live tempestas                                                                                                         |
| 6    | CAD import, commercial outputs, the driver plug-in model, vendor catalog entries, fleet learning                                                            |

## Decisions

Recorded in [Decisions](Decisions/Decisions.md), one file each:

- [0001 Hosted never commands](Decisions/0001%20Hosted%20never%20commands.md)
- [0002 The plan document is the boundary](Decisions/0002%20The%20plan%20document%20is%20the%20boundary.md)
- [0003 Deployment differences sit behind ports](Decisions/0003%20Deployment%20differences%20sit%20behind%20ports.md)
- [0004 Tenancy from the first migration](Decisions/0004%20Tenancy%20from%20the%20first%20migration.md)
- [0005 Capture media is sensitive](Decisions/0005%20Capture%20media%20is%20sensitive.md)
- [0006 Every deployment is reached by its own domain](Decisions/0006%20Every%20deployment%20is%20reached%20by%20its%20own%20domain.md)

## Open questions

- Which region first? It decides voltage, suppliers, building codes and units.
- What is the hosted domain that tenant subdomains live under?
- Is the planner part of tempestas, or a separate product sharing the domain model?
- Which crop profiles ship first, and where does their data come from?
- Where does the planner live in the monorepo — a new `apps/planner`, or routes in `apps/web`?
- What data licence does the catalog carry, and on what terms do vendors contribute?

## When to update this file

- A step in the build order starts, finishes, or changes scope
- A new decision is recorded, or an existing one is superseded
- Any of this stops being a plan and becomes something that runs
- An open question is answered

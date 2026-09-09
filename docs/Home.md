# tempestas Docs

Documentation for tempestas — the greenhouse control system: an Nx monorepo (Angular + NestJS) with
a thin Python agent per node and MQTT in between, replacing the Flask/Angular-16 pair that has run
the greenhouse for eight years.

> [!info] About the name
> _Tempestas_ is the Roman goddess of storms and weather. Aulus Atilius Calatinus dedicated a temple
> to her after his fleet survived a storm off Corsica in 259 BC — a name for the thing you appease
> when the weather is what stands between you and losing everything.
>
> Nodes are named after cities from Brandon Sanderson's Cosmere. The first is `elantris`.

> [!warning] This system runs a combustion appliance
> The CO2 generator is a propane burner and it is also the greenhouse's night heater. Read
> [[Safety]] before changing anything that can energise a relay.

## Sections

- [[Development setup|Getting Started]]
- [[Safety]] — the invariants, the failure modes, the dead-man
- [[Architecture]] — zones, nodes, devices, and where code belongs
- [[Code Quality]]
- [[Testing]]
- [[Rules and Climate]] — the control law, thresholds, DST
- [[Hardware]] — pins, polarity, relays, the SCD4x
- [[Roadmap]] — phases, what is done, open questions

### Infrastructure

- [[Database]]
- [[Home Assistant]] — the observer/controller boundary, and why the rules stay here
- [[Migrations]]
- [[MQTT Contract]]
- [[Nodes]]

## See also

- `apps/server/.env.example` — the local defaults template, including `HARDWARE_DRIVER` (`.env` itself is gitignored)
- The old system, for reference only: `~/personal-workspace/environment-controller-api`

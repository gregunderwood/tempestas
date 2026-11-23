# 0003 Deployment differences sit behind ports

- **Status:** accepted
- **Date:** 2026-11-22
- **Applies to:** [Planner](../Planner.md)

## Context

Hosted and self-hosted tempestas must be one codebase. Forking them would double every change and
let the self-hosted edition rot. But they genuinely differ in where things run and who pays for
them: a hosted planner calls a commercial AI model and stores media in object storage; a self-hosted
one may have no AI at all and a single disk.

Tempestas already solved this shape of problem once. Hardware sits behind the abstract
`HardwareService`, with `HARDWARE_DRIVER=fake|mqtt` choosing the implementation, and nothing outside
`app/hardware/` knows which one is running.

## Decision

**Everything that differs between deployments sits behind a port, with an implementation chosen by
configuration.** Domain code never knows which deployment it is in.

| Port           | Hosted                                | Self-hosted                                                     |
| -------------- | ------------------------------------- | --------------------------------------------------------------- |
| Model provider | Claude, through the service's account | The grower's own API key, a local model through Ollama, or none |
| Media storage  | S3                                    | Local disk or MinIO, through the same S3-compatible interface   |
| Job queue      | Postgres-backed queue                 | The same                                                        |
| Weather data   | A cached service                      | Open-Meteo directly, or a bundled typical-weather dataset       |
| Catalog        | Always current                        | Signed releases pulled on a schedule, or a git clone            |
| Identity       | Accounts, organisations, SSO          | A single local admin, or OIDC                                   |

**`none` is a first-class model provider.** AI accelerates capture; the deterministic engine does
the work. With no provider configured, capture falls back to the guided wizard and nothing else is
lost.

As with the hardware seam, an unknown or misconfigured implementation **fails at boot** rather than
quietly falling back to something else.

## Consequences

- Every port has at least two real implementations, and tests run against the cheap one.
- The job queue lives in Postgres in both deployments, so self-hosting needs no Redis or broker
  beyond what tempestas already runs.
- Features must be designed to degrade with `none`: AI may draft, explain and suggest, but no step
  may require it.
- The self-hosted footprint stays modest: Docker Compose on a desktop or small server, no GPU.

## Alternatives considered

- **A separate hosted edition.** Rejected: two codebases, and the self-hosted one falls behind.
- **Requiring an AI provider.** Rejected: it excludes self-hosters without one, and makes the
  product's correctness depend on a model.

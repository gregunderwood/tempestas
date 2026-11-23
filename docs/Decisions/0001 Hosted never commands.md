# 0001 Hosted never commands

- **Status:** accepted
- **Date:** 2026-11-22
- **Applies to:** [Planner](../Planner.md), and anything tempestas ever runs in the cloud

## Context

Tempestas will be offered as a hosted service as well as self-hosted. The hosted side will hold
plans, run simulations, show sites remotely and learn from many installations. It will be tempting
to let it do more: push a setpoint, toggle a fan, run the rules for a site that has no server of its
own.

The equipment at a site includes heaters and propane burners. A site's survival on a January night
cannot depend on a company's uptime, a home internet connection, or whether that company still
exists. [Safety](../Safety.md) already requires exactly one controller holding the heartbeat, and
that the controller can reach its nodes.

## Decision

**The hosted service is never in the control loop.** It never publishes a command, never holds a
node's heartbeat, and never runs the rules for a live site.

A site is always controlled by a tempestas running at that site, and keeps running with no
connection to anything hosted.

## Consequences

- Every live site needs a local controller, however small. A hosted-only tier for hardware control
  is ruled out.
- Remote view and fleet data flow **out** of a site over a connection the site opens. Nothing flows
  **in** that can energise a relay. Changes reach a site only as a plan document the local
  controller chooses to apply — see
  [0002](0002%20The%20plan%20document%20is%20the%20boundary.md).
- A grower who loses the hosted service loses planning conveniences, never control.
- Node fencing and `issuedBy` ownership stay the only authority on a relay; there is no cloud
  identity a node has to trust.

## Alternatives considered

- **Hosted control with a local fallback.** Rejected: two controllers for one relay is the failure
  [Multi-Controller](../Multi-Controller.md) exists to prevent, and the fallback is exactly the path
  that goes untested until it is needed.
- **Hosted control for sites without a server.** Rejected: it would make the cheapest tier the one
  that freezes when the internet drops.

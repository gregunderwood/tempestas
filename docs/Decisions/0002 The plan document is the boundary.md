# 0002 The plan document is the boundary

- **Status:** accepted
- **Date:** 2026-11-22
- **Applies to:** [Planner](../Planner.md), [Multi-Controller](../Multi-Controller.md)

## Context

A grower may plan in the hosted service and operate on their own hardware, or do both locally. The
plan has to cross from wherever it was made to the controller that will run it, and keep crossing as
it is revised. The two sides will run different versions: a hosted planner updated weekly, and a
controller in someone's barn that was installed three years ago.

[Multi-Controller](../Multi-Controller.md) already settled how policy moves between boxes: one
**versioned document per tier**, published whole, carrying `{epoch, version, schemaVersion,
updatedAt, updatedBy}`, applied only if newer, refused outright if its `schemaVersion` is not
understood.

## Decision

**The plan is a versioned document, and that document is the only thing that crosses between hosted
and local.**

- A finished plan becomes the site's **policy** document; there is no second format to translate
  into.
- It moves by export and import, or by the local controller **pulling** it over a connection the
  site opens. Nothing is pushed into a site.
- The local controller applies it under the existing rules: newer version only, unknown
  `schemaVersion` refused, never partially applied.
- Applying a plan that adds devices proposes them; a person still adopts each one, as discovery does
  today.

## Consequences

- `schemaVersion` becomes a public contract with a compatibility policy, because old controllers
  must keep refusing cleanly rather than misreading a newer plan.
- The planner's domain model and the controller's policy model have to converge. Planned and
  installed devices are one entity with a lifecycle state, not two models joined by a converter.
- A self-hosted planner and a hosted one produce the same document, so a grower can move between
  them.
- Remote editing of a live site is a plan revision the site pulls, not a remote procedure call.

## Alternatives considered

- **An API the hosted service calls on the site.** Rejected: it needs inbound access to home
  networks, and it is a path for commands that [0001](0001%20Hosted%20never%20commands.md) rules
  out.
- **Database replication between hosted and local.** Rejected for the same reasons per-box
  historians were chosen in [Multi-Controller](../Multi-Controller.md): it turns one hard problem
  into two.

# 0005 Capture media is sensitive

- **Status:** accepted
- **Date:** 2026-11-22
- **Applies to:** [Planner](../Planner.md), capture, media storage

## Context

Capture asks growers to photograph and film the inside of their homes, outbuildings and businesses,
and describe what they grow there. That media can show a home's layout, its security, its location,
and crops whose legality varies by jurisdiction. Commercial growers may be bound by licence
conditions on who can see their facilities.

Once a grower has uploaded it, the only protection they have is how tempestas treats it.

## Decision

**Capture media and descriptions are treated as sensitive personal data in every deployment.**

- **Encrypted at rest** and in transit.
- **Never public by default.** Sharing a plan shares the model and the bill of materials, not the
  photos, unless the grower explicitly includes them.
- **Deletion is real.** Deleting a capture removes the originals and every derived asset, not just
  the database row.
- **Location metadata is stripped** from stored copies unless the grower chooses to keep it.
- **Hosted storage stays in-country** where the grower's region requires it, and the region is
  stated plainly. Canadian residency is the first.
- **Sent to a model provider only with consent.** A grower can see which provider will receive their
  media before it is sent, and can choose `none` — see
  [0003](0003%20Deployment%20differences%20sit%20behind%20ports.md).
- **Excluded from fleet learning.** Opt-in sharing covers operating data, never capture media.

## Consequences

- The media storage port carries encryption, deletion and region as part of its contract, not as
  options a caller remembers to set.
- Derived assets keep a link to their source capture, so deletion can find them.
- Self-hosting becomes the recommended answer for growers whose licence or jurisdiction forbids
  third-party storage — a reason to offer both deployments, not a gap in the hosted one.

## Alternatives considered

- **Treat media as ordinary user content.** Rejected: a leaked photo of a grow room is a different
  order of harm from a leaked bill of materials.
- **Process media on the device only.** Rejected for now: it rules out AI-assisted capture on most
  phones. Worth revisiting as on-device models improve.

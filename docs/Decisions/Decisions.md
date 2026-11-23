# Decisions

## What it is

One file per architecture decision that is expensive to reverse. Each says what was decided, why,
what it costs, and what was rejected, so a later reader — or a later agent — does not reopen it by
accident.

| #    | Decision                                                                                                               | Status   |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Hosted never commands](0001%20Hosted%20never%20commands.md)                                                           | accepted |
| 0002 | [The plan document is the boundary](0002%20The%20plan%20document%20is%20the%20boundary.md)                             | accepted |
| 0003 | [Deployment differences sit behind ports](0003%20Deployment%20differences%20sit%20behind%20ports.md)                   | accepted |
| 0004 | [Tenancy from the first migration](0004%20Tenancy%20from%20the%20first%20migration.md)                                 | accepted |
| 0005 | [Capture media is sensitive](0005%20Capture%20media%20is%20sensitive.md)                                               | accepted |
| 0006 | [Every deployment is reached by its own domain](0006%20Every%20deployment%20is%20reached%20by%20its%20own%20domain.md) | accepted |

## Writing one

- Name it `NNNN <the decision as a sentence>.md`, numbered in order.
- Sections: a header list (status, date, what it applies to), then `Context`, `Decision`,
  `Consequences`, `Alternatives considered`.
- A decision is never edited to say something else. Write a new one, mark the old one
  `superseded by NNNN`, and link both ways.

## When to update this file

- A decision is added, superseded or withdrawn

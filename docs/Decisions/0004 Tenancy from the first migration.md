# 0004 Tenancy from the first migration

- **Status:** accepted
- **Date:** 2026-11-22
- **Applies to:** [Planner](../Planner.md), the planner's schema

## Context

The hosted service will hold many organisations' plans, media and sites, from a single hobbyist to a
commercial grower with several sites and staff. A self-hosted install will usually hold exactly one
organisation.

Adding tenancy to a schema after launch means touching every table, every query and every test, and
any query that is missed leaks one customer's data to another. It is one of the most expensive
retrofits there is.

## Decision

**The hosted service is shared tenancy: one deployment and one database for every organisation.**
Every planner table carries an `organization_id` from its first migration, and every planner query
is scoped by it. A self-hosted install creates one organisation at setup and otherwise never
mentions it.

How a request finds its organisation — a subdomain per tenant, or a tenant's own domain — is
[0006](0006%20Every%20deployment%20is%20reached%20by%20its%20own%20domain.md).

Metering of the costly operations — model calls and simulation jobs — is recorded per organisation
from the start, in both deployments.

## Consequences

- Scoping is enforced in one place, a repository layer or row-level security, not repeated by hand
  in each query, and it is tested against real Postgres: a mocked repository cannot prove isolation.
- The existing controller schema is not retrofitted. A live site is one organisation's, and stays
  single-tenant; tenancy belongs to the planner and the hosted service.
- Self-hosted carries a column it rarely needs. That is the whole cost.
- A self-hosted install can later be moved into the hosted service, or the reverse, without
  rewriting identifiers.

## Alternatives considered

- **A database per organisation.** Rejected for now: strong isolation, but migrations, backups and
  connections multiply with every customer. Worth revisiting for large commercial customers who ask
  for it.
- **Add tenancy when the hosted service launches.** Rejected: that is the expensive retrofit this
  decision exists to avoid.

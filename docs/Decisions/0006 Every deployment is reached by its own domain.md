# 0006 Every deployment is reached by its own domain

- **Status:** accepted
- **Date:** 2026-11-22
- **Applies to:** [Planner](../Planner.md), the hosted service, self-hosted installs

## Context

Growers will reach tempestas three ways: as a tenant of the hosted service, as a self-hosted install
in a cloud account of their own, and as a self-hosted install on their own LAN. Commercial growers
will want their own name on it. Hobbyists will want it to just work.

Two constraints shape every option:

- **Capture needs HTTPS.** Browsers only give a page the camera and microphone in a secure context.
  A phone capturing a grow room over `http://192.168.1.20` gets neither.
- **Tenants share one deployment** ([0004](0004%20Tenancy%20from%20the%20first%20migration.md)), so
  anything that lets one tenant's session or domain reach another's is a data leak.

## Decision

**Every deployment, hosted tenant or self-hosted, is reached by a domain name of its own, over
HTTPS.**

### Hosted: a subdomain per tenant

- Each organisation gets `<tenant>.<hosted domain>` when it signs up.
- The request's host decides the tenant, at the edge, before any application code runs. Every query
  is still scoped by `organization_id`; the subdomain chooses the tenant, it does not replace the
  scoping.
- One wildcard certificate covers every tenant subdomain, issued over ACME DNS-01.
- Session cookies are **host-only**, never set on the parent domain, so a session on one tenant's
  subdomain is never sent to another's.
- Tenant slugs that could be mistaken for the service itself — `www`, `api`, `admin`, `app`,
  `status`, and the like — are reserved.

### Hosted: a tenant's own domain

A tenant may serve their organisation from a domain they own, in either of two ways:

| Method                    | The tenant                                         | Suits                                               |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| **CNAME**                 | Points `grow.example.com` at their subdomain       | Most tenants — one DNS record, nothing else changes |
| **Nameserver delegation** | Delegates a domain or subdomain to our nameservers | Apex domains, and tenants who want us to manage DNS |

Either way:

- Ownership is **verified with a TXT record** before the domain is attached, so nobody can claim a
  domain that is not theirs.
- Certificates are issued per domain over ACME, and renewed automatically.
- A custom domain that stops pointing at us is **detached and its certificate dropped**, so a
  dangling record can never be used to serve someone else's content under the tenant's name.
- The tenant subdomain keeps working beside the custom domain.

### Self-hosted: in their cloud, or on their LAN

- **In their own cloud account:** their own domain, with a certificate from ACME. The same image as
  the hosted service, with one organisation.
- **On their LAN:** still a real domain name, resolving to the LAN address, with a certificate
  issued over ACME DNS-01, which needs no inbound port. That gives the phone a secure context for
  capture with no warnings to click through. Growers without a domain of their own can use a local
  certificate authority whose root they install on their devices; this is the fallback, documented
  but not the default.

The setup flow takes care of all of this. A grower picks hosted, their cloud, or their LAN, and is
walked through the DNS steps for that choice.

## Consequences

- The edge has to resolve tenants by host, manage a wildcard certificate, issue and renew
  certificates for custom domains, and run verification and dangling-record checks. That is real
  infrastructure, and it is built before custom domains are offered, not after.
- Offering nameserver delegation makes us a DNS host for those tenants: uptime, DNSSEC, and a record
  editor become part of the product. CNAME is shipped first; delegation follows when there is demand.
- Self-hosted LAN installs need the ACME DNS-01 integration for common DNS providers, or the local
  certificate authority fallback.
- A tenant moving between hosted and self-hosted keeps their domain; only where it points changes.
- A local controller at a site is unaffected. It keeps serving its own UI on the LAN as it does
  today, and reaches the hosted service only outbound
  ([0001](0001%20Hosted%20never%20commands.md)).

## Alternatives considered

- **Path per tenant (`/t/<tenant>`).** Rejected: every tenant shares one origin, so cookies, local
  storage and service workers are shared too, and custom domains would need a separate mechanism
  anyway.
- **A domain per tenant only, no subdomains.** Rejected: it puts a DNS chore in front of every
  hobbyist's first five minutes.
- **Plain HTTP on the LAN.** Rejected: capture would lose the camera, which is most of what capture
  is.

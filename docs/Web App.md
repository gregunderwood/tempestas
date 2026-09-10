# Web App

## What it is

`apps/web` — the Angular dashboard. LAN-only, read from a phone in a greenhouse, in sunlight,
sometimes with wet hands. Angular 20 standalone components, Angular Material M3, no SSR.

> [!note] Status
> Phase 10: the shell, the gauge component and the dashboard. The devices and nodes screens are
> still thin — phase 11.

## Key files

- [../apps/web/src/app/app.ts](../apps/web/src/app/app.ts) / [app.html](../apps/web/src/app/app.html) — the shell, and the banner
- [../apps/web/src/app/core/api-error.interceptor.ts](../apps/web/src/app/core/api-error.interceptor.ts) — the only error handling in the app
- [../apps/web/src/app/core/api.service.ts](../apps/web/src/app/core/api.service.ts) — every call, typed from `@tempestas/domain`
- [../apps/web/src/app/core/realtime.service.ts](../apps/web/src/app/core/realtime.service.ts) — the socket feed, as signals
- [../apps/web/src/app/shared/gauge/gauge.ts](../apps/web/src/app/shared/gauge/gauge.ts) — one reading, as an arc
- [../apps/web/src/app/features/dashboard/dashboard.ts](../apps/web/src/app/features/dashboard/dashboard.ts) — the dashboard
- [../apps/web/src/styles.scss](../apps/web/src/styles.scss) — the M3 theme and the gauge band colours
- [../apps/web/proxy.conf.json](../apps/web/proxy.conf.json) — `/api` and `/socket.io` to `:7000` in dev

## Errors happen in exactly one place

The old client had **no** error handling worth the name. The API returned `{ error: "..." }` inside
HTTP 200 bodies, so components carried four near-identical `if (res.error)` blocks, there was no
`catchError` anywhere, and a failure that did not match one of those four shapes vanished silently.

Here every request passes through `apiErrorInterceptor`, registered once in `app.config.ts`:

- It **prefers the server's own message**. Every error the API raises carries a machine-readable
  `code` and a message written for a human; inventing a friendlier one here would only hide which
  of them happened.
- `status === 0` is not a server error at all — the Pi is unreachable, which on a home LAN is the
  common case and says so plainly.
- An expected refusal (already-on, already-off, cooldown) shows for 6s; anything else for 12s. A
  cooldown message that vanishes before it is read is a bug report waiting to happen.
- It **reports and rethrows**. The interceptor never swallows, so a caller can still react.

The invariant to keep: `grep -rn "\.error\b" apps/web/src` should find nothing that looks like
checking a success body for an error field.

## The stale-sensor banner

Layer 1 of the safety design holds last state when readings stop — it does not fail everything off
(which can freeze the greenhouse) and does not force heat on (which can cook it). [Safety](Safety.md)
is explicit that this is _"only sound if the alarm is actually visible"_.

**This banner is that alarm.** It lives in the shell rather than on a screen, it is not dismissible,
and it names the affected roles. It is driven by `sensorStale` on the `system:status` socket event,
which the server caches and replays on connect so a browser opening mid-cycle sees it immediately.

Treat it as a required part of the feature. A change that makes it easier to miss is a safety
change, not a styling one.

## No icon font, and why

**`mat-icon` is not used anywhere, and adding it back is a regression.** Angular Material renders an
icon as a _ligature_, so without the Material Symbols font loaded it prints the ligature name as
plain text — the stale-sensor banner showed the word "warning" clipped by the icon's 24 px box to
"wa", and the connection indicator showed "wi". It had been that way since the shell was built.

Icons are Unicode glyphs and CSS shapes instead. That fixes it offline too, which matters: this is a
LAN-only app and a Google Fonts link is a network fetch that a greenhouse Pi cannot always make.
Dropping `MatIconModule` also took **19 kB off the initial bundle** — more than the whole gauge
feature added.

## The gauge

Ranges, bands and `gaugeColorFor` come from `@tempestas/domain`, not from the component, because the
rules engine and the gauge have to agree about what "orange" means. What each band _looks_ like is
this app's business and lives as `--temp-gauge-*` custom properties in `styles.scss`, picked darker
and more saturated than Material's defaults — a pale amber and a pale green are the same colour on a
washed-out phone screen in sunlight.

Three properties are load-bearing rather than cosmetic:

- **A null value renders an em-dash and the word "unknown", and draws no arc at all.** Never a zero.
  "0 ppm" reads as extremely low, which is the one direction that runs the burner.
- **Nothing is conveyed by colour alone.** Unknown says "unknown"; an energised relay says "ON".
- **The arc is clamped**, so a reading outside the configured range fills or empties it rather than
  drawing past the track.

`:host` sets `display: block; min-width: 0` because the grid item is the host element, not the
figure inside it, and an inline host will not shrink below its content.

## The dashboard shows a reading's age

The shell banner fires only when an **owned role** goes stale. A node can go quiet without that, so
each card carries its own age and marks itself after two minutes. A confident number with nothing
saying how old it is is how somebody trusts a reading from an hour ago.

## Realtime is a patch, never the source

`GET /api/devices` is authoritative — the server derives `isOn` from `onAt`/`offAt`, and a socket
message can always be missed. So the socket feed _patches_ what the API established:

```ts
this.devices.update((all) => all.map((d) => (d.id === pushed.id ? pushed : d)));
```

Device state is deliberately **not** cached or replayed by the server for the same reason. Readings
and system status are, because for those a stale-but-present value beats an empty screen.

## Patterns to follow

### ✅ Type every call from the shared library

```ts
import type { Device, Node, Reading } from '@tempestas/domain';
```

The old client hand-duplicated its types and declared `Reading.id` as `number` when it is a UUID.
That mistake cannot compile now.

### ✅ Render an unknown CO2 as an em-dash

```html
{{ reading.co2 === null ? '—' : (reading.co2 | number: '1.0-0') }} ppm
```

Null means the sensor had no answer. Showing `0 ppm` reads as "extremely low", which is the one
direction that runs the burner.

### ❌ Don't put `force-on` next to an ordinary toggle

It bypasses the anti-short-cycle interlock on a propane burner. If it is exposed at all it wants a
confirmation, not a button beside "Turn on".

### ❌ Don't add a second place that handles HTTP errors

That is how the old client ended up with four of them and no coverage.

## Pitfalls

- **`nx serve web` needs the API.** The proxy sends `/api` and `/socket.io` to `:7000`; without the
  server running every screen is empty and the snackbar says the controller is unreachable — which
  is correct, and confusing the first time.
- **Never run `nx serve web` on the Pi.** 1.5–2.5 GiB of dev server on a 3.7 GiB box puts Postgres
  and the sidecar in reach of the OOM killer. See [Development setup](Getting%20Started/Development%20setup.md).
- **Angular Material 20 is M3** and dropped `deeppurple-amber`, which the old app used. The theme is
  declared with `mat.theme()` in `styles.scss` rather than taking a prebuilt.
- **The budget is 500 kB initial / 1 MB error.** Angular Material adds up; check the build output
  before adding a component library.

## When to update this file

- A screen moves out of placeholder status (phases 10 and 11)
- The error-handling contract changes
- The banner's trigger or wording changes
- A second realtime consumer appears

# Web App

## What it is

`apps/web` — the Angular dashboard. LAN-only, read from a phone in a greenhouse, in sunlight,
sometimes with wet hands. Angular 20 standalone components, Angular Material M3, no SSR.

> [!note] Status
> A side-rail shell with a top bar on every screen, and a dashboard of four live panels. The
> devices and nodes screens are still thin.

## Key files

- [../apps/web/src/app/app.ts](../apps/web/src/app/app.ts) / [app.html](../apps/web/src/app/app.html) — the shell: rail, top bar and banner
- [../apps/web/src/app/core/page-heading.ts](../apps/web/src/app/core/page-heading.ts) — the top bar's title and subtitle
- [../apps/web/src/app/core/api-error.interceptor.ts](../apps/web/src/app/core/api-error.interceptor.ts) — the only error handling in the app
- [../apps/web/src/app/core/api.service.ts](../apps/web/src/app/core/api.service.ts) — every call, typed from `@tempestas/domain`
- [../apps/web/src/app/core/realtime.service.ts](../apps/web/src/app/core/realtime.service.ts) — the socket feed, as signals
- [../apps/web/src/app/shared/gauge/gauge.ts](../apps/web/src/app/shared/gauge/gauge.ts) — one reading, as an arc
- [../apps/web/src/app/features/dashboard/dashboard.ts](../apps/web/src/app/features/dashboard/dashboard.ts) — the dashboard, composing its four panels
- [../apps/web/src/app/features/dashboard/activity-log.ts](../apps/web/src/app/features/dashboard/activity-log.ts) — rules decisions and relay switches, newest first
- [../apps/web/src/app/core/live-nodes.ts](../apps/web/src/app/core/live-nodes.ts) — the nodes, fetched and patched from `node:state`
- [../apps/web/src/app/features/nodes/nodes-page.ts](../apps/web/src/app/features/nodes/nodes-page.ts) — every node, with admit and disable
- [../apps/web/src/app/shared/pinboard/pinboard.ts](../apps/web/src/app/shared/pinboard/pinboard.ts) — the card board, with drag and drop and the move buttons
- [../apps/web/src/app/shared/arrange/card-order.ts](../apps/web/src/app/shared/arrange/card-order.ts) — card order: a drop or a move, merging a saved order, browser storage
- [../apps/web/src/app/features/nodes/node-detail.ts](../apps/web/src/app/features/nodes/node-detail.ts) — one node, with its 24-hour statistics
- [../apps/web/src/app/features/reports/reports-page.ts](../apps/web/src/app/features/reports/reports-page.ts) — the reports screen: equipment runtime, and the reports still to come
- [../apps/web/src/styles.scss](../apps/web/src/styles.scss) — the M3 theme, the rail and hero tokens, and the gauge band colours
- [../apps/web/proxy.conf.json](../apps/web/proxy.conf.json) — `/api` and `/socket.io` to `:7000` in dev

## The shell

At **64rem and wider** the nav is a rail down the left that is always shown, and the hamburger is
not displayed. Below that the rail becomes a drawer behind a hamburger in the top bar. The switch
is **CSS media queries only**: no `BreakpointObserver`, no `mat-sidenav`. The open state is a
signal rather than a CSS trick for one reason: a closed drawer is `display: none`, so its links
leave the tab order and the accessibility tree. It closes on navigation, on Escape and on the
scrim.

Nav glyphs are inline SVG paths in a lookup table in `app.ts`, stroked in `currentColor`. The
active link is bold and carries a leading bar as well as a different fill, and it sets
`aria-current="page"`.

The **top bar** is sticky and names the screen. Its title and subtitle come from the route's
`data: { heading, subtitle }`, read from the deepest route on every `NavigationEnd`. A page that
knows more can override it with `PageHeading.showPage()`: node detail shows the node's display
name, with its slug, kind and whether it is online. The next navigation resets it. Pages no longer
render their own `<h1>`.

The live/offline indicator shows in the rail's foot on a wide screen and in the top bar on a
narrow one. Offline is a hollow dot and the word "offline", never colour alone.

Colours come from the M3 tokens. The rail uses the **fixed** tokens
(`--mat-sys-on-primary-fixed-variant` and `--mat-sys-primary-fixed`), which keep one tone in light
and dark mode, so the rail looks the same in both. Cards are restyled once with
`mat.card-overrides` in `styles.scss`, not per screen.

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
and it names the affected roles. It sits in the content column, full width, under the top bar and
above the page, so it is never inside the drawer that a narrow screen hides. `app.spec.ts` checks
that placement with the menu open and closed. It is driven by `sensorStale` on the `system:status` socket event,
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

## The nodes screen

`/nodes` lists every node with its status, whether it is online, its device count and agent. It
follows `node:state` over the socket: a node going offline, coming back, announcing itself as
pending, being admitted elsewhere or upgrading its agent shows without a reload. Admit and disable
also refetch the list after they succeed, so the button still works with the socket down. See
[Realtime](Infrastructure/Realtime.md).

## The node screen

`/nodes/:slug` is the drill-in: live gauges, then min, max and average per metric across the last
three **day and night periods**, most recent first, so the one still running is at the top — with
**the clock time of each extreme**. The API returns them chronologically, which is the sane order
for any other caller; reversing them is a presentation choice made in the component. A 38 °C peak at 14:00 is the greenhouse working; the same peak at 03:00 is
a fault, and the value alone cannot tell them apart.

There is no combined 24-hour row, deliberately: the burner is enrichment by day and heat by night,
so a figure spanning both describes neither. See
[Readings](Infrastructure/Readings.md#day-and-night-not-24-hours).

### These figures are a query, not a push

The gauges arrive over the socket; the statistics do not. Left alone the table freezes while the
gauges keep moving — and the running period is by definition still accumulating, so it drifts
further the longer the page is open. So a new `reading:latest` from **this node** re-queries
them, **throttled to once a minute**: the first new reading opens a 60 s window and the query runs
at its end. A reading no newer than the newest one the page held when it asked is already in
them, so the readings the page opens with, and the one the socket replays on connect, start no
window. It also re-queries **the moment the running period ends**, when every row shifts.

There is no timer. A node that has gone quiet adds nothing to its statistics, so they are not
re-queried until it speaks again.

Slow on purpose: a min or max a minute old is not misleading, and each refresh is three periods of
aggregate queries against the readings table on an SD card. Refreshing on every `reading:latest`
would be a round trip every 10 s per open browser.

The node itself, which feeds the top bar's "online" or "offline", comes from `injectLiveNodes`
and follows `node:state`, so a reboot shows offline and then online without a reload, and so does
a node that stays connected but stops sending readings.

**The boundary instant comes from the server** as `nextBoundary`. A client that worked it out
itself would be a second definition of night, free to disagree with the one driving the relay.

Rows are labelled by **kind** — "Day", "Night", "Day so far" — and identified by a dated span, not
by "last night". Which night is "last" depends on whether it is currently night, and a label that
is right half the time is worse than one that never claims it.

Two mechanics worth knowing:

- **The route must be declared before `nodes`.** Angular matches in order and `nodes` is a prefix
  match, so it swallows `/nodes/elantris` if it comes first.
- **A required `input()` has no value in the constructor.** The stats query is driven off
  `toObservable(this.slug)` rather than read once, which also handles moving between two nodes —
  the router reuses the component instead of building a new one.

Every figure on it can legitimately be absent and renders as an em-dash. A window with no valid CO2
has no CO2 average. A metric the node never measures, such as humidity on a pipe-probe node, gets
no gauge and no block at all: a block of dashes would read as a broken sensor rather than one that
was never there.

Each relay on the node is listed with three things beyond its name and pin:

- **Its state in words**, "ON" or "off", because colour is not readable on a phone in sunlight and
  an energised relay here can mean a propane burner is alight.
- **Whether anything is driving it**, "automatic" or "manual". An idle relay under manual control
  and one the rules engine is deciding about look identical otherwise.
- **The minimum-off hold while one is in force**, "held off until 14:05 (300s minimum off)". The
  interlock is invisible otherwise, and "why is it not coming on?" is the question it produces.

## The dashboard

Four panels, every one of them fed by the socket. None of them polls, and none of them switches
anything: there are no relay buttons here, and never `force-on`.

- **Hero.** One line of system state, with the worst problem first: offline, then following,
  failing rules, quiet sensors, warnings, and finally "All zones running normally". Under it are
  when the rules last ran and how many nodes are online. Below that is a tile for each zone and
  role that tempestas drives, with the reading that role is controlled on, the decision in words
  ("ON · below setpoint") and how long ago it was made.
- **Stat cards**, one per node:
  - each metric as a large figure, with a trend chip and a bar showing where the figure sits in
    the gauge's range, in the band colour;
  - an age line;
  - each relay's state in words, "ON since 14:02" or "off", with the date when it switched on
    before today.
- **Needs attention**, read-only:
  - the socket being down;
  - a follower that is not leading;
  - nodes waiting to be admitted;
  - probes quiet for over two minutes;
  - zones whose rules failed;
  - decisions that warn.

  Each one links to the screen that deals with it. When the list is empty it says "Nothing needs
  you."

- **Activity**: relay switches, rules decisions that changed since the previous cycle, newly
  failing zones and failed dispatches, newest first, each with its clock time. The panel shows
  when the rules last ran.

A server that stops leading forgets its rules cycle without saying so on the socket, so the
client drops its cycle as soon as a status says `isLeading: false`. The tiles, the warnings and
"Rules ran" then show nothing rather than a follower's stale decisions, and the activity log treats
the next cycle as its first. The zones page says "This controller is a follower; rules run on the
leader" above its cards instead, so an ageing cycle never reads as stalled rules there.

Every figure that can be unknown renders an **em-dash**: a tile's reading, a stat's value, its
trend and its range bar, and the count of nodes online before the first status arrives.

### The trend is since the period began, not since some minutes ago

The trend chip shows the change since the **start of the day or night now running**, because the
burner does enrichment by day and heat by night, and a change that straddles dusk describes
neither. The baseline is each sensor's first reading in that period. The client asks each node's
`day-night` stats for the period's `from`. Once a sensor's live reading falls inside that period,
it asks for that one sensor's first reading since `from` (`nodeId` with `sensorId`, `order=oldest-first`,
`limit=1`). A probe that was quiet at the boundary gets its baseline as soon as it speaks again,
and a probe that has been quiet all period is never asked about. Per sensor matters: a node's
readings are interleaved, so one chatty probe would otherwise push a quieter one off the end of
any row limit.

The period is fetched again at the server's `nextBoundary`, never at a boundary the client works
out for itself. A failed request, or a sensor whose first reading has not landed yet, is tried
again after a minute, and nothing is asked faster than that, even when a phone's clock runs ahead
of the server's and the boundary looks already past. A period that has ended is dropped rather
than shown under the wrong label. Both requests are background requests,
so a failure leaves an em-dash and raises no snackbar.

### The activity log outlives the page

`ActivityLog` is a root service, so leaving the dashboard and coming back keeps its history. The
shell starts it when the app opens, and it keeps the newest 30 entries. It reads
`recentDevicePushes`, every push in arrival order and numbered, rather than the latest push per
device, so a relay switched on and off between two reads logs both. A failed dispatch is logged when it first fails, not again on every cycle while it
keeps failing. When it starts it loads the device list once, so each relay's first push is
compared with a known state rather than with the clock. The controller stamps `onAt` and the phone
stamps the push, and the two can be minutes apart. Only a device missing from that list falls
back to counting as a switch when its `onAt` or `offAt` is within a minute of the push, so opening
the page does not replay every relay as news. Rules decisions are compared with the
previous cycle, so the first cycle after the app opens is the baseline for decisions and records
none. Failures are different: a zone already failing, or a dispatch already failing, is logged
from that first cycle, because it is happening now.

### Cards are pinned, not gridded

The dashboard's node cards and the zones page's zone cards sit on a shared pinboard
(`shared/pinboard/`). Each card goes into whichever column is shortest, so a short card leaves no
gap the way a grid row would. The pinboard measures each card's real height. Every column has
the same width, so a card's height holds wherever it moves. Empty columns are kept, so a lone card
is one column wide rather than stretched across the page. Once cards are placed and measured,
they stay in their columns as their contents change. A new card goes under the shortest column and
a removed card leaves its gap, so neither moves the others. The whole board repacks only while it
is first being measured and when the column count changes. After a column change it measures
every card once the new columns are drawn and packs again from those heights, because a card that
did not change size reports nothing on its own. Moving a card rebuilds it, which would drop
keyboard focus inside it. A change of card order also repacks the whole board, in the new order.

### Arrange mode

The order of the cards is a person's choice, not alphabetical. On the dashboard and the zones
page the top bar has an **Arrange** button. Only while it is pressed does each card show a
labelled **Drag** handle and **Move earlier** and **Move later** buttons, so a scroll on a phone is
never taken as a drag. The board says it is arranging in words as well, and the pressed button
carries a tick, so the mode is never shown by colour alone. Every handle and button is at least
3rem tall. **Reset order** sits beside Arrange while it is on.

- **Dragging** uses `@angular/cdk/drag-drop`, one drop list per pinboard column, joined by
  `cdkDropListGroup`. A drop becomes a position in the card order: just before the card the dragged
  one landed above, or just after the last card of the column it landed at the foot of.
- **The move buttons** are the keyboard and screen reader route, since CDK dragging is pointer
  only. Each step swaps a card with its neighbour in the order, and focus follows the card to the
  same button even when it changes column.
- **The order is kept in `localStorage`**, under `tempestas.card-order.dashboard` and
  `tempestas.card-order.zones`, so each browser has its own arrangement and nothing is written to
  the server. A card missing from the saved order, such as a newly admitted node, goes at the end.
  A saved entry for a card that no longer exists is ignored. Storage that is blocked, full or holds
  anything but a list of strings falls back to the default order without an error.

The order logic is plain functions in `shared/arrange/card-order.ts`, specced there.
`injectCardArrangement` binds a page's order to the top bar's buttons through the root
`ArrangeMode` service, and leaving the page withdraws it and turns Arrange off.

### Each card still shows a reading's age

The shell banner fires only when an **owned role** goes stale. A node can go quiet without that, so
each card carries its own age and marks itself after two minutes. A confident number with nothing
saying how old it is is how somebody trusts a reading from an hour ago.

## The reports screen

`/reports` answers the questions a list of raw rows never did: was it a good night, is the heater
working harder, did the pumphouse get close to freezing. Equipment runtime is the first report: a
card per device with its hours on, starts, shortest run and unknown hours, a bar per day, and a
day-by-day table. Below it, a card names the reports still to come — time in range, freeze margin,
CO2 enrichment and node health — and loses a line as each lands.

A report is fetched once and fetched again whenever a device switches or a node goes offline or
comes back, so it follows the relays without polling. The server side, and the rules for unknown spans, midnight and offline nodes, are
in [Reports](Infrastructure/Reports.md).

It replaced a Readings screen that listed the latest hundred rows, newest first. `/readings` still
redirects here so an old bookmark does not land on the dashboard by way of the catch-all. The
`/api/readings` endpoints stay: the dashboard and the node screen read them.

## Realtime is a patch, never the source

`GET /api/devices` is authoritative — the server derives `isOn` from `onAt`/`offAt`, and a socket
message can always be missed. So the socket feed _patches_ what the API established:

```ts
this.devices.update((all) => all.map((d) => (d.id === pushed.id ? pushed : d)));
```

Nodes follow the same rule: `GET /api/nodes` is authoritative and `node:state` patches it.
Device and node state are deliberately **not** cached or replayed by the server for the same
reason. Readings and system status are, because for those a stale-but-present value beats an empty
screen.

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
- **The budget is 1 MB initial / 2 MB error, and it is a tripwire, not a target.** The app is
  served over the LAN, so a few hundred kB more costs nothing anybody would notice, even on one
  bar of Wi-Fi in the pumphouse. The budget is there to flag a library pulled in by mistake, such
  as an icon font or a charting package; a warning means look at what was added, not squeeze the
  code to fit.

## When to update this file

- A screen moves out of placeholder status
- The shell's breakpoint, or how a page sets its heading, changes
- A dashboard panel gains or loses a source
- The error-handling contract changes
- The banner's trigger or wording changes
- A second realtime consumer appears

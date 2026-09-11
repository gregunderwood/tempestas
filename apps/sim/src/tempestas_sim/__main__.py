"""Run the shared greenhouse."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .clock import SimClock
from .server import LOCAL_TZ, Simulation, serve
from .world import Air, Fixture, Model, World

HERE = Path(__file__).resolve().parents[2]


def load_fixtures(path: Path) -> list[Fixture]:
    raw = json.loads(path.read_text())
    return [
        Fixture(
            node_id=f["node_id"], pin=int(f["pin"]), role=f["role"], on_level=int(f["on_level"])
        )
        for f in raw["fixtures"]
    ]


def main() -> int:
    p = argparse.ArgumentParser(prog="tempestas-sim", description=__doc__)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=7100)
    p.add_argument("--model", type=Path, default=HERE / "greenhouse-model.json")
    p.add_argument("--wiring", type=Path, default=HERE / "sandbox-wiring.json")
    p.add_argument("--speed", type=float, default=1.0, help="sim minutes per real minute")
    p.add_argument("--start", default=None, help="ISO start time, local tz if naive")
    p.add_argument("--co2", type=float, default=700.0)
    p.add_argument("--temp", type=float, default=18.0)
    p.add_argument("--outdoor-mean", type=float, default=12.0)
    p.add_argument("--outdoor-swing", type=float, default=7.0)
    args = p.parse_args()

    start = datetime.now(tz=LOCAL_TZ)
    if args.start:
        parsed = datetime.fromisoformat(args.start)
        start = parsed if parsed.tzinfo else parsed.replace(tzinfo=ZoneInfo("America/Vancouver"))

    model = Model.load(args.model)
    world = World(
        model,
        load_fixtures(args.wiring),
        air=Air(co2_ppm=args.co2, temp_c=args.temp, vapour_hpa=14.0),
        outdoor_mean_c=args.outdoor_mean,
        outdoor_swing_c=args.outdoor_swing,
    )
    sim = Simulation(world, SimClock(start, speed=args.speed))
    server = serve(sim, args.host, args.port)

    print(f"greenhouse sim on http://{args.host}:{args.port}")
    print(f"  start {start.isoformat()}  speed {args.speed}x")
    for _key, f in sorted(world.fixtures.items()):
        print(f"  {f.node_id}:{f.pin:<3} {f.role:<14} ON={f.on_level}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Run the shared greenhouse."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from .clock import SimClock
from .server import LOCAL_TZ, Simulation, create_server
from .world import Air, Fixture, Model, World

SIM_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PORT = 7100
CLI_START_VAPOUR_HPA = 14.0


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="tempestas-sim", description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", type=Path, default=SIM_ROOT / "greenhouse-model.json")
    parser.add_argument("--wiring", type=Path, default=SIM_ROOT / "sandbox-wiring.json")
    parser.add_argument("--speed", type=float, default=1.0, help="sim minutes per real minute")
    parser.add_argument("--start", default=None, help="ISO start time, local tz if naive")
    parser.add_argument("--co2", type=float, default=700.0)
    parser.add_argument("--temp", type=float, default=18.0)
    parser.add_argument("--outdoor-mean", type=float, default=12.0)
    parser.add_argument("--outdoor-swing", type=float, default=7.0)
    return parser.parse_args()


def load_fixtures(path: Path) -> list[Fixture]:
    wiring = json.loads(path.read_text())
    return [
        Fixture(
            node_id=fixture["node_id"],
            pin=int(fixture["pin"]),
            role=fixture["role"],
            on_level=int(fixture["on_level"]),
        )
        for fixture in wiring["fixtures"]
    ]


def resolve_start(start_text: str | None) -> datetime:
    if not start_text:
        return datetime.now(tz=LOCAL_TZ)
    parsed = datetime.fromisoformat(start_text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=LOCAL_TZ)


def build_world(arguments: argparse.Namespace) -> World:
    return World(
        Model.load(arguments.model),
        load_fixtures(arguments.wiring),
        air=Air(co2_ppm=arguments.co2, temp_c=arguments.temp, vapour_hpa=CLI_START_VAPOUR_HPA),
        outdoor_mean_c=arguments.outdoor_mean,
        outdoor_swing_c=arguments.outdoor_swing,
    )


def print_banner(arguments: argparse.Namespace, start: datetime, world: World) -> None:
    print(f"greenhouse sim on http://{arguments.host}:{arguments.port}")
    print(f"  start {start.isoformat()}  speed {arguments.speed}x")
    for _key, fixture in sorted(world.fixtures.items()):
        print(f"  {fixture.node_id}:{fixture.pin:<3} {fixture.role:<14} ON={fixture.on_level}")


def main() -> int:
    arguments = parse_arguments()
    start = resolve_start(arguments.start)
    world = build_world(arguments)
    simulation = Simulation(world, SimClock(start, speed=arguments.speed))
    server = create_server(simulation, arguments.host, arguments.port)

    print_banner(arguments, start, world)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

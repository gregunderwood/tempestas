"""The tempestas node agent.

One process per node. It owns that box's sensors and relays and speaks the MQTT
contract in `libs/domain/src/lib/hardware/mqtt-contract.ts` - which lives in the
same repository on purpose, so a change to the contract touches both sides in
one commit rather than becoming a two-repo dance done wrong at 2am.
"""

__version__ = "0.1.0"

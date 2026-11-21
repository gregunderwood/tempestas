"""The server stores a node's kind in a Postgres enum, so a kind it does not know fails the hello."""

import re
from pathlib import Path

import settings

NODE_MODEL = Path(__file__).resolve().parents[3] / "libs/domain/src/lib/nodes/node.model.ts"
NODE_KIND_ENUM = re.compile(r"export enum NodeKind \{(?P<body>.*?)\}", re.DOTALL)
ENUM_STRING_VALUE = re.compile(r"=\s*'(?P<value>[^']+)'")


def read_server_node_kinds():
    enum_body = NODE_KIND_ENUM.search(NODE_MODEL.read_text()).group("body")
    return {match.group("value") for match in ENUM_STRING_VALUE.finditer(enum_body)}


def test_the_server_knows_this_node_kind():
    assert settings.NODE_KIND in read_server_node_kinds()


def test_the_server_kinds_are_read():
    assert {"rpi", "esp32", "pico", "virtual"} <= read_server_node_kinds()

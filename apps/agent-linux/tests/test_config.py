"""Configuration, and the things it refuses to start with."""

from __future__ import annotations

import pytest

from tempestas_agent.config import ConfigError, load


def write_config(tmp_path, body: str):
    path = tmp_path / "agent.toml"
    path.write_text(body)
    return path


def test_node_id_is_required(tmp_path):
    # Guessing a slug would put this node on somebody else's topics.
    with pytest.raises(ConfigError, match="node_id"):
        load(write_config(tmp_path, "kind = 'rpi'\n"), env={})


def test_env_overrides_the_file(tmp_path):
    path = write_config(tmp_path, 'node_id = "from-file"\n')
    assert load(path, env={"TEMPESTAS_NODE_ID": "from-env"}).node_id == "from-env"


def test_no_lines_means_no_gpio(tmp_path):
    config = load(write_config(tmp_path, 'node_id = "bench"\n'), env={})
    assert config.gpio.lines == ()
    assert config.has_gpio is False


# A line nobody has decided about, on a board where one of them is a propane burner.
def test_every_managed_line_needs_a_failsafe_level(tmp_path):
    body = 'node_id = "bench"\n[gpio]\nlines = [16, 20]\n[gpio.failsafe]\n16 = 1\n'
    with pytest.raises(ConfigError, match="failsafe"):
        load(write_config(tmp_path, body), env={})


def test_a_failsafe_for_an_unmanaged_line_is_refused(tmp_path):
    body = 'node_id = "bench"\n[gpio]\nlines = [16]\n[gpio.failsafe]\n16 = 1\n20 = 1\n'
    with pytest.raises(ConfigError, match="not managed"):
        load(write_config(tmp_path, body), env={})


def test_a_fully_declared_gpio_config_loads(tmp_path):
    body = 'node_id = "bench"\n[gpio]\nlines = [16]\n[gpio.failsafe]\n16 = 1\n'
    config = load(write_config(tmp_path, body), env={})
    assert config.has_gpio is True
    assert config.gpio.failsafe == {16: 1}


def test_an_unknown_sensor_kind_is_refused(tmp_path):
    body = 'node_id = "bench"\n[sensor]\nkind = "guesswork"\n'
    with pytest.raises(ConfigError, match="sensor.kind"):
        load(write_config(tmp_path, body), env={})


def test_a_pointlessly_fast_sample_interval_is_refused(tmp_path):
    # The SCD4x produces a reading every 5 s; asking faster returns the same one.
    body = 'node_id = "bench"\n[sensor]\nsample_interval_s = 1\n'
    with pytest.raises(ConfigError, match="sample_interval_s"):
        load(write_config(tmp_path, body), env={})


def test_mqtt_url_is_split_into_host_and_port(tmp_path):
    body = 'node_id = "bench"\n[mqtt]\nurl = "mqtt://192.168.2.70:1884"\n'
    config = load(write_config(tmp_path, body), env={})
    assert (config.mqtt.host, config.mqtt.port) == ("192.168.2.70", 1884)


PROBES = """node_id = "pumphouse"
[sensor]
kind = "ds18b20"
[[sensor.probes]]
rom = "28-0000000000A1"
sensor_id = "pipes"
[[sensor.probes]]
rom = "28-0000000000b2"
sensor_id = "air"
"""


class TestProbes:
    def test_probes_load_in_order_with_roms_lowercased(self, tmp_path):
        config = load(write_config(tmp_path, PROBES), env={})
        assert [(probe.rom, probe.sensor_id) for probe in config.sensor.probes] == [
            ("28-0000000000a1", "pipes"),
            ("28-0000000000b2", "air"),
        ]

    def test_a_ds18b20_node_needs_at_least_one_probe(self, tmp_path):
        body = 'node_id = "pumphouse"\n[sensor]\nkind = "ds18b20"\n'
        with pytest.raises(ConfigError, match="at least one"):
            load(write_config(tmp_path, body), env={})

    # Ignored probes would be a pumphouse nobody is measuring.
    def test_probes_on_another_kind_are_refused(self, tmp_path):
        body = PROBES.replace('kind = "ds18b20"', 'kind = "scd4x"')
        with pytest.raises(ConfigError, match="only read for"):
            load(write_config(tmp_path, body), env={})

    @pytest.mark.parametrize("rom", ["28-123", "10-0000000000a1", "pipes", ""])
    def test_a_malformed_rom_is_refused(self, tmp_path, rom):
        body = PROBES.replace("28-0000000000A1", rom)
        with pytest.raises(ConfigError, match="ROM id"):
            load(write_config(tmp_path, body), env={})

    # It is an MQTT topic segment and the tail of a sensor:<node>/<id> source.
    @pytest.mark.parametrize("sensor_id", ["pipe probe", "a/b", "a+", "#", ""])
    def test_a_sensor_id_that_cannot_be_a_topic_segment_is_refused(self, tmp_path, sensor_id):
        body = PROBES.replace('"pipes"', f'"{sensor_id}"')
        with pytest.raises(ConfigError, match="sensor_id"):
            load(write_config(tmp_path, body), env={})

    # Two probes under one name alternate as one sensor; one probe under two is counted twice.
    @pytest.mark.parametrize(
        ("old", "new", "field"),
        [('"air"', '"pipes"', "sensor_id"), ("28-0000000000b2", "28-0000000000a1", "rom")],
    )
    def test_duplicates_are_refused(self, tmp_path, old, new, field):
        with pytest.raises(ConfigError, match=f"repeats a {field}"):
            load(write_config(tmp_path, PROBES.replace(old, new)), env={})

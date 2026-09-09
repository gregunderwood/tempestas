"""Configuration, and the things it refuses to start with."""

from __future__ import annotations

import pytest

from tempestas_agent.config import ConfigError, load


def write(tmp_path, body: str):
    path = tmp_path / "agent.toml"
    path.write_text(body)
    return path


def test_node_id_is_required(tmp_path):
    # A node's slug is its MQTT topic segment and its broker ACL subject.
    # Guessing one would put this node on somebody else's topics.
    with pytest.raises(ConfigError, match="node_id"):
        load(write(tmp_path, "kind = 'rpi'\n"), env={})


def test_env_overrides_the_file(tmp_path):
    path = write(tmp_path, 'node_id = "from-file"\n')
    assert load(path, env={"TEMPESTAS_NODE_ID": "from-env"}).node_id == "from-env"


def test_no_lines_means_no_gpio(tmp_path):
    config = load(write(tmp_path, 'node_id = "bench"\n'), env={})
    assert config.gpio.lines == ()
    assert config.has_gpio is False


# A managed line with no declared safe level is a line nobody has decided
# about, on a board where one of them is a propane burner.
def test_every_managed_line_needs_a_failsafe_level(tmp_path):
    body = 'node_id = "bench"\n[gpio]\nlines = [16, 20]\n[gpio.failsafe]\n16 = 1\n'
    with pytest.raises(ConfigError, match="failsafe"):
        load(write(tmp_path, body), env={})


def test_a_failsafe_for_an_unmanaged_line_is_refused(tmp_path):
    body = 'node_id = "bench"\n[gpio]\nlines = [16]\n[gpio.failsafe]\n16 = 1\n20 = 1\n'
    with pytest.raises(ConfigError, match="not managed"):
        load(write(tmp_path, body), env={})


def test_a_fully_declared_gpio_config_loads(tmp_path):
    body = 'node_id = "bench"\n[gpio]\nlines = [16]\n[gpio.failsafe]\n16 = 1\n'
    config = load(write(tmp_path, body), env={})
    assert config.has_gpio is True
    assert config.gpio.failsafe == {16: 1}


def test_an_unknown_sensor_kind_is_refused(tmp_path):
    body = 'node_id = "bench"\n[sensor]\nkind = "guesswork"\n'
    with pytest.raises(ConfigError, match="sensor.kind"):
        load(write(tmp_path, body), env={})


def test_a_pointlessly_fast_sample_interval_is_refused(tmp_path):
    # The SCD4x produces a reading every 5s; asking faster returns the same one.
    body = 'node_id = "bench"\n[sensor]\nsample_interval_s = 1\n'
    with pytest.raises(ConfigError, match="sample_interval_s"):
        load(write(tmp_path, body), env={})


def test_mqtt_url_is_split_into_host_and_port(tmp_path):
    body = 'node_id = "bench"\n[mqtt]\nurl = "mqtt://192.168.2.70:1884"\n'
    config = load(write(tmp_path, body), env={})
    assert (config.mqtt.host, config.mqtt.port) == ("192.168.2.70", 1884)

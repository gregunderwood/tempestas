import importlib.util
from pathlib import Path

CLEAR_SLOT_FILE = Path(__file__).resolve().parents[1] / "usb" / "clear_slot.py"
SLOT = "a"


def load_clear_slot():
    spec = importlib.util.spec_from_file_location("clear_slot", CLEAR_SLOT_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_clears_the_slot_and_the_old_flat_layout_but_keeps_the_rest(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    for name in ("slots.json", "node_runtime.py", "board.py", "settings.py", "credentials.py"):
        (tmp_path / name).write_text("old")
    (tmp_path / SLOT / "boards").mkdir(parents=True)
    (tmp_path / SLOT / "boards" / "pico_w.py").write_text("old")
    (tmp_path / SLOT / "node_runtime.py").write_text("old")
    (tmp_path / "b").mkdir()

    root_files = ["slots.json", "node_runtime.py", "board.py", "gone.py"]
    load_clear_slot().clear_slot_and_flat_layout(SLOT, root_files)

    assert sorted(path.name for path in tmp_path.iterdir()) == ["a", "b", "credentials.py", "settings.py"]
    assert list((tmp_path / SLOT).iterdir()) == []


def test_makes_the_slot_on_a_board_that_never_had_one(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    load_clear_slot().clear_slot_and_flat_layout(SLOT, ["slots.json"])

    assert (tmp_path / SLOT).is_dir()

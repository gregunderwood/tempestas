import ast
import hashlib
import inspect
import json
import subprocess
from pathlib import Path

import slots
from bootloader import BOOTLOADER_VERSION
from slot_installer import ROOT_ONLY_FILES, SlotInstaller
from slots import SlotStore

APP_DIRECTORY = Path(__file__).resolve().parents[1]
REPOSITORY = APP_DIRECTORY.parents[1]
DEVICE_DIRECTORY = APP_DIRECTORY / "device"
FILE_LISTS = ("MICROPYTHON_BOOTLOADER", "MICROPYTHON_AGENT_CODE", "MICROPYTHON_NODE_CONFIG")
# Untracked, as it holds the Wi-Fi password, so its tracked template stands in for it.
FILES_MADE_FROM_TEMPLATES = {"credentials.example.py": "credentials.py"}
BUNDLED_VERSION = "1.2.1"
RUNNING_VERSION = "1.2.0"
BOARD = "pico_w"
BUNDLE_URL = "http://elantris:7000/api/agent-releases/agent-micropython/" + BUNDLED_VERSION
# A node keeps the slots.py of its last USB deploy, so a release may use only what every node has.
FROZEN_SLOTS_MODULE_SIGNATURES = {
    "SlotStore": "(root='/')",
    "find_other_slot": "(slot)",
    "join_path": "(directory, name)",
}
FROZEN_SLOT_STORE_SIGNATURES = {
    "abandon_pending": "(self, reason)",
    "clear_outcome": "(self)",
    "keep_pending": "(self)",
    "locate": "(self, name)",
    "read": "(self)",
    "start_pending": "(self, slot, command_id, version)",
}
FROZEN_SLOT_STORE_ATTRIBUTES = {"root"}
FROZEN_SLOTS_MODULE_NAMES = set(FROZEN_SLOTS_MODULE_SIGNATURES)
FROZEN_SLOT_STORE_NAMES = set(FROZEN_SLOT_STORE_SIGNATURES) | FROZEN_SLOT_STORE_ATTRIBUTES
FROZEN_FILES = ("main.py", "bootloader.py", "slots.py")
# Changing a frozen file fails here until BOOTLOADER_VERSION is raised and its digest added.
FROZEN_FILES_SHA256_BY_BOOTLOADER_VERSION = {
    3: "89c8987fbb7dfbaa5ab5e6ad1aa92222f615dd69460f0ef1bc95077c67abe70e",
}


def read_file_list(list_name):
    script = 'source "$1"; printf "%%s\\n" "${%s[@]}"' % list_name
    output = subprocess.run(
        ["bash", "-c", script, "bash", str(APP_DIRECTORY / "agent-files.sh")],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return output.split()


def list_tracked_device_modules():
    output = subprocess.run(
        ["git", "-C", str(DEVICE_DIRECTORY), "ls-files", "*.py"], check=True, capture_output=True, text=True
    ).stdout
    return {FILES_MADE_FROM_TEMPLATES.get(path, path) for path in output.split() if "/" not in path}


def build_bundle(output_directory):
    script = """
        source "$1/apps/agent-micropython/agent-files.sh"
        source "$1/tools/lib/agent-bundle.sh"
        mkdir -p "$2/files"
        copy_agent_files "$1" agent-micropython "$2/files" "$3"
        write_bundle_manifest "$2" agent-micropython "$3"
    """
    subprocess.run(
        ["bash", "-c", script, "bash", str(REPOSITORY), str(output_directory), BUNDLED_VERSION], check=True
    )


class BundleOnDisk:
    """Serves a bundle directory at the URLs the server's agent-releases route gives it."""

    def __init__(self, bundle_directory):
        self.bundle_directory = bundle_directory

    def fetch(self, url, write_chunk, max_bytes):
        relative_path = url[len(BUNDLE_URL) + 1 :]
        write_chunk((self.bundle_directory / relative_path).read_bytes())


def test_every_device_module_is_in_exactly_one_file_list():
    listed = [name for list_name in FILE_LISTS for name in read_file_list(list_name)]

    assert sorted(listed) == sorted(set(listed))
    assert set(listed) == list_tracked_device_modules()


def test_a_bundle_from_the_deploy_installs_into_a_slot_that_can_boot(tmp_path):
    bundle_directory = tmp_path / "bundle"
    build_bundle(bundle_directory)
    manifest_bytes = (bundle_directory / "manifest.json").read_bytes()
    board_root = tmp_path / "board"
    board_root.mkdir()
    store = SlotStore(str(board_root))
    store.write({"active": "a", "pending": None, "outcome": None})
    (board_root / "a").mkdir()
    installer = SlotInstaller(store, BundleOnDisk(bundle_directory), BOARD, RUNNING_VERSION)
    command = {
        "id": "update-1",
        "version": BUNDLED_VERSION,
        "manifestUrl": BUNDLE_URL + "/manifest.json",
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
    }

    assert installer.install(command, lambda state: None) == "b"

    slot = board_root / "b"
    for module in read_file_list("MICROPYTHON_AGENT_CODE"):
        assert (slot / module).read_bytes() == (DEVICE_DIRECTORY / module).read_bytes()
    assert (slot / "board.py").read_bytes() == (DEVICE_DIRECTORY / "boards" / (BOARD + ".py")).read_bytes()
    assert (slot / "deployed_version.py").read_text() == 'AGENT_VERSION = "%s"\n' % BUNDLED_VERSION
    for module in read_file_list("MICROPYTHON_BOOTLOADER") + read_file_list("MICROPYTHON_NODE_CONFIG"):
        assert not (slot / module).exists()
    assert json.loads(manifest_bytes)["contractMinor"] == 2


def test_only_the_bootloader_and_node_config_are_kept_out_of_a_slot():
    root_files = read_file_list("MICROPYTHON_BOOTLOADER") + read_file_list("MICROPYTHON_NODE_CONFIG")
    assert sorted(ROOT_ONLY_FILES) == sorted(root_files)


def list_frozen_names_used(module_path):
    module_names, store_names = set(), set()
    for node in ast.walk(ast.parse(module_path.read_text())):
        if isinstance(node, ast.ImportFrom) and node.module == "slots":
            module_names.update(alias.name for alias in node.names)
            assert all(alias.asname is None for alias in node.names), module_path
        elif isinstance(node, ast.Import):
            assert all(alias.asname is None for alias in node.names if alias.name == "slots"), module_path
        elif isinstance(node, ast.Attribute) and read_name(node.value) == "slots":
            module_names.add(node.attr)
        elif isinstance(node, ast.Attribute) and is_slot_store(node.value):
            store_names.add(node.attr)
    return module_names, store_names


def read_name(expression):
    if isinstance(expression, ast.Name):
        return expression.id
    if isinstance(expression, ast.Attribute):
        return expression.attr
    return None


def is_slot_store(expression):
    if isinstance(expression, ast.Call):
        return read_name(expression.func) == "SlotStore"
    name = read_name(expression)
    return name is not None and name.endswith("store")


def test_slot_code_uses_only_the_frozen_slots_interface():
    for module in read_file_list("MICROPYTHON_AGENT_CODE"):
        module_names, store_names = list_frozen_names_used(DEVICE_DIRECTORY / module)
        assert module_names <= FROZEN_SLOTS_MODULE_NAMES, module
        assert store_names <= FROZEN_SLOT_STORE_NAMES, module


def test_the_frozen_slots_interface_keeps_its_signatures():
    for name, signature in FROZEN_SLOTS_MODULE_SIGNATURES.items():
        assert str(inspect.signature(getattr(slots, name))) == signature, name
    for name, signature in FROZEN_SLOT_STORE_SIGNATURES.items():
        assert str(inspect.signature(getattr(SlotStore, name))) == signature, name
    assert all(hasattr(SlotStore(), name) for name in FROZEN_SLOT_STORE_ATTRIBUTES)


def test_a_change_to_a_frozen_file_raises_the_bootloader_version():
    digest = hashlib.sha256()
    for name in FROZEN_FILES:
        digest.update((DEVICE_DIRECTORY / name).read_bytes())
    assert FROZEN_FILES_SHA256_BY_BOOTLOADER_VERSION.get(BOOTLOADER_VERSION) == digest.hexdigest(), (
        "main.py, bootloader.py or slots.py changed: raise BOOTLOADER_VERSION and pin the new digest"
    )

"""Fills the slot that is not running, so nothing changes until every file is verified."""

import binascii
import hashlib
import json
import os

import contract
import slots
from agent_version import AGENT_NAME
from http_fetch import FetchFailed
from update_guard import is_sha256_hex

BUNDLE_FILES_DIRECTORY = "files"
BOARDS_DIRECTORY = "boards"
BOARD_FILE = "board.py"
MAX_MANIFEST_BYTES = 16 * 1024
MAX_FILE_BYTES = 64 * 1024
# Room left over for slots.json and the flash's own bookkeeping.
FREE_FLASH_MARGIN_BYTES = 32 * 1024
DIRECTORY_MODE = 0x4000
STAT_MODE = 0
STAT_SIZE = 6
STATVFS_FRAGMENT_SIZE = 1
STATVFS_AVAILABLE_BLOCKS = 4
COPY_CHUNK_BYTES = 1024


class UpdateFailed(Exception):
    pass


class SlotInstaller:
    def __init__(self, store, fetcher, board_name, running_version):
        self.store = store
        self.fetcher = fetcher
        self.board_name = board_name
        self.running_version = running_version

    def install(self, command, report):
        version = command["version"]
        target_slot = self.choose_target_slot(version)
        target_directory = self.store.locate(target_slot)
        try:
            report(contract.UpdateState.DOWNLOADING)
            manifest = self.fetch_verified_manifest(command)
            self.require_board_file(manifest["files"])
            remove_tree(target_directory)
            self.require_free_flash()
            hashes_by_path = self.download_files(command["manifestUrl"], manifest["files"], target_directory)
            report(contract.UpdateState.VERIFYING)
            verify_files(manifest["files"], hashes_by_path)
            report(contract.UpdateState.INSTALLING)
            self.install_board_file(target_directory)
            self.store.start_pending(target_slot, command["id"], version)
        except (FetchFailed, OSError) as error:
            remove_tree(target_directory)
            raise UpdateFailed(str(error)) from error
        except UpdateFailed:
            remove_tree(target_directory)
            raise
        return target_slot

    def choose_target_slot(self, version):
        state = self.store.read()
        if state is None:
            raise UpdateFailed(
                "this node is not on the slot layout, so it needs tools/deploy-agent-micropython.sh"
            )
        if version == self.running_version:
            raise UpdateFailed("this node already runs %s" % version)
        return slots.find_other_slot(state["active"])

    def fetch_verified_manifest(self, command):
        manifest_bytes = bytearray()
        self.fetcher.fetch(command["manifestUrl"], manifest_bytes.extend, MAX_MANIFEST_BYTES)
        if hash_sha256(manifest_bytes) != command["manifestSha256"]:
            raise UpdateFailed("the manifest does not match the manifestSha256 in the command")
        manifest = parse_manifest(manifest_bytes)
        problem = describe_manifest_problem(manifest, command["version"])
        if problem is not None:
            raise UpdateFailed(problem)
        return manifest

    def require_board_file(self, files):
        board_path = self.locate_board_in_bundle()
        if not any(listed_file["path"] == board_path for listed_file in files):
            raise UpdateFailed("the bundle has no %s for this %s board" % (board_path, self.board_name))

    def locate_board_in_bundle(self):
        return BOARDS_DIRECTORY + "/" + self.board_name + ".py"

    def require_free_flash(self):
        needed_bytes = measure_tree(self.store.locate(self.read_active_slot())) + FREE_FLASH_MARGIN_BYTES
        free_bytes = measure_free_flash(self.store.root)
        if free_bytes < needed_bytes:
            raise UpdateFailed(
                "only %d bytes of flash are free, and the update needs about %d" % (free_bytes, needed_bytes)
            )

    def read_active_slot(self):
        return self.store.read()["active"]

    def download_files(self, manifest_url, files, target_directory):
        hashes_by_path = {}
        for listed_file in files:
            path = listed_file["path"]
            destination = slots.join_path(target_directory, path)
            make_parent_directories(target_directory, path)
            hashes_by_path[path] = self.download_file(build_file_url(manifest_url, path), destination)
        return hashes_by_path

    def download_file(self, url, destination):
        hasher = hashlib.sha256()
        with open(destination, "wb") as file:

            def write_chunk(chunk):
                hasher.update(chunk)
                file.write(chunk)

            self.fetcher.fetch(url, write_chunk, MAX_FILE_BYTES)
        return binascii.hexlify(hasher.digest()).decode()

    def install_board_file(self, target_directory):
        # A bundle carries every board; this node runs its own, as the USB deploy installs it.
        copy_file(
            slots.join_path(target_directory, self.locate_board_in_bundle()),
            slots.join_path(target_directory, BOARD_FILE),
        )


def parse_manifest(manifest_bytes):
    try:
        manifest = json.loads(bytes(manifest_bytes))
    except ValueError as error:
        raise UpdateFailed("the manifest is not JSON") from error
    if not isinstance(manifest, dict):
        raise UpdateFailed("the manifest is not a JSON object")
    return manifest


def describe_manifest_problem(manifest, version):
    if manifest.get("app") != AGENT_NAME:
        return "the manifest is for %s, not %s" % (json.dumps(manifest.get("app")), AGENT_NAME)
    if manifest.get("version") != version:
        return "the manifest is for %s, not %s" % (json.dumps(manifest.get("version")), version)
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        return "the manifest lists no files"
    for listed_file in files:
        if not is_listed_file_well_formed(listed_file):
            return "the manifest lists %s, not a safe path with a sha256" % json.dumps(listed_file)
    return None


def is_listed_file_well_formed(listed_file):
    return (
        isinstance(listed_file, dict)
        and is_sha256_hex(listed_file.get("sha256"))
        and is_safe_relative_path(listed_file.get("path"))
    )


def is_safe_relative_path(path):
    if not isinstance(path, str) or path == "" or path.startswith("/") or "\\" in path:
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))


def verify_files(files, hashes_by_path):
    for listed_file in files:
        if hashes_by_path.get(listed_file["path"]) != listed_file["sha256"]:
            raise UpdateFailed("%s does not have the sha256 the manifest gives" % listed_file["path"])


def build_file_url(manifest_url, path):
    # The files sit beside the manifest, and need its query too.
    address, separator, query = manifest_url.partition("?")
    file_url = address.rpartition("/")[0] + "/" + BUNDLE_FILES_DIRECTORY + "/" + path
    return file_url + separator + query


def hash_sha256(content):
    return binascii.hexlify(hashlib.sha256(content).digest()).decode()


def is_directory(path):
    try:
        return os.stat(path)[STAT_MODE] & DIRECTORY_MODE != 0
    except OSError:
        return False


def remove_tree(path):
    if not is_directory(path):
        return
    for name in os.listdir(path):
        child = slots.join_path(path, name)
        if is_directory(child):
            remove_tree(child)
        else:
            os.remove(child)
    os.rmdir(path)


def measure_tree(path):
    if not is_directory(path):
        return 0
    total_bytes = 0
    for name in os.listdir(path):
        child = slots.join_path(path, name)
        total_bytes += measure_tree(child) if is_directory(child) else os.stat(child)[STAT_SIZE]
    return total_bytes


def measure_free_flash(path):
    filesystem = os.statvfs(path)
    return filesystem[STATVFS_FRAGMENT_SIZE] * filesystem[STATVFS_AVAILABLE_BLOCKS]


def make_parent_directories(root, relative_path):
    directory = root
    if not is_directory(directory):
        os.mkdir(directory)
    for part in relative_path.split("/")[:-1]:
        directory = slots.join_path(directory, part)
        if not is_directory(directory):
            os.mkdir(directory)


def copy_file(source, destination):
    with open(source, "rb") as reader, open(destination, "wb") as writer:
        while True:
            chunk = reader.read(COPY_CHUNK_BYTES)
            if not chunk:
                return
            writer.write(chunk)

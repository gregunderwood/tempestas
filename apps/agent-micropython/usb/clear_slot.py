"""Run on the board by tools/deploy-agent-micropython.sh before it copies a slot in."""

import os

DIRECTORY_MODE_BIT = 0x4000


def remove_tree(path):
    for name in os.listdir(path):
        child = path + "/" + name
        if os.stat(child)[0] & DIRECTORY_MODE_BIT:
            remove_tree(child)
        else:
            os.remove(child)
    os.rmdir(path)


def clear_slot_and_flat_layout(slot, root_files):
    # Here rather than with mpremote's rm, which fails on a file that is not there.
    present_names = os.listdir()
    for name in root_files:
        if name in present_names:
            os.remove(name)
    if slot in present_names:
        remove_tree(slot)
    os.mkdir(slot)

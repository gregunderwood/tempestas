import time

import node_runtime

BOOT_GRACE_SECONDS = 5

# The watchdog cannot be stopped once armed, so a deploy has to catch the board before run().
print("tempestas agent starts in %d s; Ctrl-C keeps the REPL" % BOOT_GRACE_SECONDS)
time.sleep(BOOT_GRACE_SECONDS)
node_runtime.run()

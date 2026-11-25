// Pure: the one night a seeded node drops out, shared so its relays and its readings go quiet together.
import { startOfLocalDay } from './history-window.mjs';

export const OUTAGE_DAYS_AGO = 12;
const OUTAGE_FROM = { hour: 1, minute: 30 };
const OUTAGE_UNTIL = { hour: 5, minute: 0 };

// The first node by slug, so the outage lands on the same node every run.
export function chooseOutageNode(nodeIds) {
  return [...nodeIds].sort()[0];
}

export function findOutage(now, timezone) {
  const day = startOfLocalDay(now, timezone).minus({ days: OUTAGE_DAYS_AGO });
  return {
    from: day.set(OUTAGE_FROM).toJSDate(),
    until: day.set(OUTAGE_UNTIL).toJSDate(),
  };
}

export function isDuringOutage(instant, outage) {
  return instant >= outage.from && instant < outage.until;
}

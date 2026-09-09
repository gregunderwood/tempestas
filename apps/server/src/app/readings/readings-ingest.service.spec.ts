import { NEVER } from 'rxjs';
import type { Repository } from 'typeorm';
import { FixedClock } from '../common/clock';
import type {
  HardwareService,
  SensorSample,
} from '../hardware/hardware.service';
import type { NodesService, SampleResolution } from '../nodes/nodes.service';
import { ReadingsIngestService } from './readings-ingest.service';
import type { SensorReadingEntity } from './models';

const NOW = new Date('2026-01-10T12:00:00Z');

function sample(overrides: Partial<SensorSample> = {}): SensorSample {
  return {
    nodeId: 'elantris',
    sensorId: 'scd4x-0',
    receivedAt: NOW,
    temperature: 21.5,
    humidity: 55.2,
    co2: 812,
    nodeSeq: 7,
    ...overrides,
  };
}

function makeService(
  resolution: SampleResolution,
  raw: unknown[] = [{ id: 'reading-uuid' }],
) {
  const execute = vi.fn().mockResolvedValue({ raw });
  const orIgnore = vi.fn(() => ({ execute }));
  const values = vi.fn(() => ({ orIgnore }));
  const insert = vi.fn(() => ({ values }));
  const readings = {
    createQueryBuilder: vi.fn(() => ({ insert })),
  } as unknown as Repository<SensorReadingEntity>;

  const nodes = {
    resolveForSample: vi.fn().mockResolvedValue(resolution),
  } as unknown as NodesService;
  const hardware = { samples$: NEVER } as unknown as HardwareService;

  const service = new ReadingsIngestService(
    readings,
    nodes,
    hardware,
    new FixedClock(NOW),
  );
  return { service, values, orIgnore, insert };
}

/** The uuid is what the FK is written from; the bootId scopes the dedupe. */
const ADMITTED = {
  accepted: true,
  node: { id: 'node-uuid', bootId: 'boot-7' },
} as unknown as SampleResolution;

describe('ReadingsIngestService', () => {
  it('persists a sample from an admitted node against the node uuid', async () => {
    const { service, values } = makeService(ADMITTED);
    await expect(service.ingest(sample())).resolves.toBe('persisted');

    expect(values).toHaveBeenCalledWith({
      nodeId: 'node-uuid',
      bootId: 'boot-7',
      sensorId: 'scd4x-0',
      temperature: 21.5,
      humidity: 55.2,
      co2: 812,
      // bigint column: a string, or Postgres gets a float for a large seq.
      nodeSeq: '7',
    });
  });

  // The whole point of the gate: unbelievable data never enters the table, so
  // nothing downstream has to remember to re-check.
  it('discards a sample from a pending node without writing anything', async () => {
    const { service, insert } = makeService({
      accepted: false,
      reason: 'pending',
    });
    await expect(service.ingest(sample())).resolves.toBe('discarded');
    expect(insert).not.toHaveBeenCalled();
  });

  it('discards a sample from a node it has never heard of', async () => {
    const { service, insert } = makeService({
      accepted: false,
      reason: 'unknown-node',
    });
    await expect(service.ingest(sample({ nodeId: 'ghost' }))).resolves.toBe(
      'discarded',
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('discards a sample from a disabled node', async () => {
    const { service, insert } = makeService({
      accepted: false,
      reason: 'disabled',
    });
    await expect(service.ingest(sample())).resolves.toBe('discarded');
    expect(insert).not.toHaveBeenCalled();
  });

  // MQTT QoS 1 is at-least-once. A duplicate sample would mean a duplicate
  // rules evaluation, so it is absorbed by the unique index, not by a read.
  it('absorbs a QoS-1 duplicate via ON CONFLICT DO NOTHING', async () => {
    const { service, orIgnore } = makeService(ADMITTED, []);
    await expect(service.ingest(sample())).resolves.toBe('duplicate');
    expect(orIgnore).toHaveBeenCalled();
  });

  // A dead sensor whose last good value was low would otherwise let the burner
  // run indefinitely on a phantom "CO2 is low".
  it('stores an invalid CO2 as null, never as zero', async () => {
    const { service, values } = makeService(ADMITTED);
    await service.ingest(sample({ co2: null }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ co2: null }));
  });

  it('rounds CO2 to the integer column rather than letting Postgres refuse it', async () => {
    const { service, values } = makeService(ADMITTED);
    await service.ingest(sample({ co2: 812.6 }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ co2: 813 }));
  });
});

// The dedupe key has to include the boot generation. A node's sequence counter
// restarts at 1 when its agent does - an ESP32 has nowhere cheap to persist one
// - so without this every sample after a reboot collided with the previous
// boot's rows and was dropped, presenting as a stale sensor rather than a fault.
describe('dedupe is scoped to the node boot', () => {
  it('writes the boot generation alongside the sequence number', async () => {
    const { service, values } = makeService(ADMITTED);
    await service.ingest(sample({ nodeSeq: 1 }));
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ bootId: 'boot-7', nodeSeq: '1' }),
    );
  });

  it('carries a null boot generation rather than inventing one', async () => {
    const noBoot = {
      accepted: true,
      node: { id: 'node-uuid', bootId: null },
    } as unknown as SampleResolution;
    const { service, values } = makeService(noBoot);
    await service.ingest(sample());
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ bootId: null }),
    );
  });
});

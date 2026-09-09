import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { NodeEntity } from '../nodes/models';

@Entity({ name: 'sensor_readings' })
// The old schema had NO index on created_at across 2.87M rows, while every
// query ordered or filtered on it.
@Index('ix_readings_created_at', ['createdAt'])
@Index('ix_readings_node_created_at', ['nodeId', 'createdAt'])
// MQTT QoS 1 is at-least-once, and on a flaky ESP32 link duplicate samples are
// not hypothetical. A duplicate sample would mean a duplicate rules evaluation.
//
// Scoped to the BOOT, not just the node. A node's sequence counter restarts at 1
// when its agent restarts - an ESP32 has nowhere cheap to persist one - so a
// node-and-seq key silently swallowed every sample after a reboot until the
// counter passed its previous high-water mark. That failure is invisible: it
// looks exactly like a stale sensor, and it stops the burner being driven by
// fresh data.
@Unique('uq_readings_node_sensor_boot_seq', [
  'nodeId',
  'sensorId',
  'bootId',
  'nodeSeq',
])
export class SensorReadingEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'node_id' })
  nodeId!: string;

  @ManyToOne(() => NodeEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'node_id' })
  node!: NodeEntity;

  @Column({ type: 'text', name: 'sensor_id' })
  sensorId!: string;

  @Column({ type: 'double precision' })
  temperature!: number;

  @Column({ type: 'double precision' })
  humidity!: number;

  /**
   * Null when the sensor reported an invalid CO2 value. The node never
   * substitutes a last-known-good value; downstream a null is coerced to
   * +Infinity so the generator stays off during the day.
   */
  @Column({ type: 'integer', nullable: true })
  co2!: number | null;

  /** Advisory, from the node. Diagnostic only - an ESP32 has no RTC. */
  @Column({ type: 'bigint', name: 'node_seq', nullable: true })
  nodeSeq!: string | null;

  /**
   * The node's boot generation, copied from `nodes.boot_id` at ingest. Part of
   * the dedupe key above, and useful provenance on its own: it says which run of
   * which agent produced this row. Null for a node that has not said hello.
   */
  @Column({ type: 'text', name: 'boot_id', nullable: true })
  bootId!: string | null;

  @Column({ type: 'timestamptz', name: 'node_ts', nullable: true })
  nodeTs!: Date | null;

  /** Server-stamped on receipt. This is the authoritative time axis. */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

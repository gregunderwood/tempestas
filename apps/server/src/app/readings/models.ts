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
@Unique('uq_readings_node_sensor_seq', ['nodeId', 'sensorId', 'nodeSeq'])
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

  @Column({ type: 'timestamptz', name: 'node_ts', nullable: true })
  nodeTs!: Date | null;

  /** Server-stamped on receipt. This is the authoritative time axis. */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

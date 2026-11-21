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
@Index('ix_readings_created_at', ['createdAt'])
@Index('ix_readings_node_created_at', ['nodeId', 'createdAt'])
// Scoped to the boot: a node's seq restarts at 1 whenever its agent does.
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

  @Column({ type: 'double precision', nullable: true })
  humidity!: number | null;

  // Null is unknown, never zero, so a dead sensor cannot read as low CO2.
  @Column({ type: 'integer', nullable: true })
  co2!: number | null;

  @Column({ type: 'bigint', name: 'node_seq', nullable: true })
  nodeSeq!: string | null;

  @Column({ type: 'text', name: 'boot_id', nullable: true })
  bootId!: string | null;

  // Diagnostic only: an ESP32 has no RTC.
  @Column({ type: 'timestamptz', name: 'node_ts', nullable: true })
  nodeTs!: Date | null;

  // Server-stamped on receipt, so this is the authoritative time axis.
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

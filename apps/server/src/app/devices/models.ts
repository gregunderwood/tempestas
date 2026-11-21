import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { DeviceRole, type GpioLevel } from '@tempestas/domain';
import { NodeEntity } from '../nodes/models';
import { ZoneEntity } from '../zones/models';

// No `is_on` column: on/off is derived from the timestamps in `device-state.ts`.
@Entity({ name: 'devices' })
// Unique per node, not on gpio alone: pin 17 on a Pi and on an ESP32 are different pins.
@Unique('uq_devices_node_gpio', ['nodeId', 'gpio'])
// Not unique: several fans or lights may share a role and get the same decision.
@Index('ix_devices_zone_role', ['zoneId', 'role'])
export class DeviceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'node_id' })
  nodeId!: string;

  @ManyToOne(() => NodeEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'node_id' })
  node!: NodeEntity;

  @Column({ type: 'uuid', name: 'zone_id' })
  zoneId!: string;

  @ManyToOne(() => ZoneEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'zone_id' })
  zone!: ZoneEntity;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'integer' })
  gpio!: number;

  /** Minimum-off time in seconds. */
  @Column({ type: 'integer', name: 'on_delay_duration', default: 0 })
  onDelayDuration!: number;

  @Column({ type: 'timestamptz', name: 'on_at', nullable: true })
  onAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'off_at', nullable: true })
  offAt!: Date | null;

  /** Per device, not a constant: four relays are active-LOW, one active-HIGH. */
  @Column({ type: 'smallint', name: 'on_level', default: 1 })
  onLevel!: GpioLevel;

  /** Manual override: automation skips the device, REST still drives it. */
  @Column({ type: 'boolean', name: 'rules_enabled', default: true })
  rulesEnabled!: boolean;

  /** What automation binds to, so renaming a device cannot break its rule. */
  @Column({ type: 'enum', enum: DeviceRole, nullable: true })
  role!: DeviceRole | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

// Keyed on the physical line, not a device; see docs/Infrastructure/Database.md.
@Entity({ name: 'pin_transitions' })
@Index('ix_pin_transitions_line_time', ['nodeId', 'pin', 'observedAt'])
@Index('ix_pin_transitions_time', ['observedAt'])
export class PinTransitionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The node slug - the MQTT topic segment, not a foreign key. */
  @Column({ type: 'text', name: 'node_id' })
  nodeId!: string;

  @Column({ type: 'integer' })
  pin!: number;

  /** `null` with `known = false` means unknown, which is not off. */
  @Column({ type: 'smallint', nullable: true })
  level!: GpioLevel | null;

  @Column({ type: 'boolean' })
  known!: boolean;

  /** Stored, not derived, so a later `onLevel` edit cannot rewrite history. */
  @Column({ type: 'boolean', nullable: true })
  energised!: boolean | null;

  /** The device that claimed this pin at the time, if any. Nullable, no FK. */
  @Column({ type: 'uuid', name: 'device_id', nullable: true })
  deviceId!: string | null;

  @Column({ type: 'text', nullable: true })
  role!: string | null;

  @Column({ type: 'text' })
  reason!: string;

  /** When the node observed the line, not when we heard about it. */
  @Column({ type: 'timestamptz', name: 'observed_at' })
  observedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'recorded_at' })
  recordedAt!: Date;
}

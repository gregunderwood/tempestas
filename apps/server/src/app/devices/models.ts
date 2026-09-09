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

/**
 * A relay-controlled device.
 *
 * Note what is NOT here: there is no `is_on` column. On/off is derived from
 * `onAt > offAt`, and the anti-short-cycle interlock from
 * `offAt + onDelayDuration`. See `device-state.ts` for those pure functions.
 */
@Entity({ name: 'devices' })
// A pin is only meaningful within its node: pin 17 on a Pi and pin 17 on an
// ESP32 are different pins. Deliberately NOT unique on gpio alone.
@Unique('uq_devices_node_gpio', ['nodeId', 'gpio'])
// Rules look devices up by (zone, role). Roles are NOT unique - several fans
// or several lights may share one, and all of them get the same decision.
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

  /** Minimum-off time in seconds. Stops a burner short-cycling. */
  @Column({ type: 'integer', name: 'on_delay_duration', default: 0 })
  onDelayDuration!: number;

  @Column({ type: 'timestamptz', name: 'on_at', nullable: true })
  onAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'off_at', nullable: true })
  offAt!: Date | null;

  /**
   * The electrical level that means ON for this device. Per-device data, not a
   * constant: four of the five existing relays are active-LOW, one active-HIGH.
   * Replaces the old `on_state`, which crossed the wire as bool/string/int.
   */
  @Column({ type: 'smallint', name: 'on_level', default: 1 })
  onLevel!: GpioLevel;

  /** Per-device manual override: automation skips it, REST still works. */
  @Column({ type: 'boolean', name: 'rules_enabled', default: true })
  rulesEnabled!: boolean;

  /** What automation binds to. Renaming the device no longer breaks its rule. */
  @Column({ type: 'enum', enum: DeviceRole, nullable: true })
  role!: DeviceRole | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

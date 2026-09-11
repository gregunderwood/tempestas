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

/**
 * Every observed change of a relay line, as the node saw it.
 *
 * The gap this fills: `devices` carries only the CURRENT `onAt`/`offAt`, so the
 * moment a relay changes, the previous change is gone. Fitting the burner model
 * therefore had to infer relay state from the CO2 curve it was supposed to
 * explain, and three constants that trade off against each other could not be
 * separated - see apps/sim/fit/README.md.
 *
 * Keyed on `(nodeId, pin)` rather than on a device, because that pair is the
 * physical fact. A device row can be renamed, re-bound to another pin, or
 * deleted; the copper it used to point at still moved when it moved.
 */
@Entity({ name: 'pin_transitions' })
// The query this table exists for: "what did this line do between these times".
@Index('ix_pin_transitions_line_time', ['nodeId', 'pin', 'observedAt'])
// And the one the fitting scripts use: a whole window across every line.
@Index('ix_pin_transitions_time', ['observedAt'])
export class PinTransitionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The node slug - the MQTT topic segment, not a foreign key. */
  @Column({ type: 'text', name: 'node_id' })
  nodeId!: string;

  @Column({ type: 'integer' })
  pin!: number;

  /** `null` with `known = false` means the line's state is not known. */
  @Column({ type: 'smallint', nullable: true })
  level!: GpioLevel | null;

  @Column({ type: 'boolean' })
  known!: boolean;

  /**
   * What this level MEANT, resolved when the row was written.
   *
   * Stored rather than derived later, because `onLevel` is editable per device
   * - the MH light is active-HIGH on a board whose other four channels are
   * active-LOW - so editing a device next month would otherwise rewrite what
   * last month's history meant.
   */
  @Column({ type: 'boolean', nullable: true })
  energised!: boolean | null;

  /** The device that claimed this pin at the time, if any. Nullable, no FK. */
  @Column({ type: 'uuid', name: 'device_id', nullable: true })
  deviceId!: string | null;

  @Column({ type: 'text', nullable: true })
  role!: string | null;

  /** Why the row exists: first-sight, level-changed, became-unknown. */
  @Column({ type: 'text' })
  reason!: string;

  /**
   * When the NODE observed the line - not when we heard about it.
   *
   * The distinction is the whole value of the table for fitting: a command
   * round trip and a reconnect both add delay, and aligning relay changes to
   * 10-second readings needs the moment the relay actually moved.
   */
  @Column({ type: 'timestamptz', name: 'observed_at' })
  observedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'recorded_at' })
  recordedAt!: Date;
}

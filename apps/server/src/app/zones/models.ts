import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ZoneRulesConfig } from '@tempestas/domain';
import { NodeEntity } from '../nodes/models';

/**
 * A zone is an airspace. Rules scope here rather than to a node, so a rule can
 * read the sensor at one end of the greenhouse and actuate a relay at the other.
 */
@Entity({ name: 'zones' })
export class ZoneEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ type: 'text', name: 'display_name' })
  displayName!: string;

  /**
   * Thresholds, enabledRoles and the per-role sensor policy. Operational policy
   * that controls a heater lives server-side as data, never shipped as consts
   * in the browser bundle where a stale cache could disagree about a setpoint.
   */
  @Column({ type: 'jsonb', name: 'rules_config' })
  rulesConfig!: ZoneRulesConfig;

  @OneToMany(() => NodeEntity, (node) => node.zone)
  nodes!: NodeEntity[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

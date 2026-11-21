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

// An airspace: rules scope here, not to a node, so a rule can read one end of the greenhouse and drive the other.
@Entity({ name: 'zones' })
export class ZoneEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ type: 'text', name: 'display_name' })
  displayName!: string;

  @Column({ type: 'jsonb', name: 'rules_config' })
  rulesConfig!: ZoneRulesConfig;

  @OneToMany(() => NodeEntity, (node) => node.zone)
  nodes!: NodeEntity[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

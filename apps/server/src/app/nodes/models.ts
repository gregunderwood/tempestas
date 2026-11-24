import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  NodeKind,
  NodeStatus,
  type AgentApp,
  type NodeCapabilities,
  type NodeUpdateOutcome,
  type UpdateState,
} from '@tempestas/domain';
import { ZoneEntity } from '../zones/models';

@Entity({ name: 'nodes' })
export class NodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Immutable: it is the MQTT topic segment and the ACL subject. `displayName` is the editable one.
  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ type: 'text', name: 'display_name' })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  location!: string | null;

  // Display only. Nothing in the server may branch on this.
  @Column({ type: 'enum', enum: NodeKind, default: NodeKind.RaspberryPi })
  kind!: NodeKind;

  // Pending until a human admits it, so a stray ESP32 cannot inject a reading that starts a burner.
  @Column({ type: 'enum', enum: NodeStatus, default: NodeStatus.Pending })
  status!: NodeStatus;

  @Column({ type: 'jsonb' })
  capabilities!: NodeCapabilities;

  @Column({ type: 'text', name: 'agent_name', nullable: true })
  agentName!: string | null;

  @Column({ type: 'text', name: 'agent_version', nullable: true })
  agentVersion!: string | null;

  // A column, not memory, so a node's bounce is detectable across a server restart too.
  @Column({ type: 'text', name: 'boot_id', nullable: true })
  bootId!: string | null;

  // Driven by the retained LWT, persisted so the list view is one query.
  @Column({ type: 'boolean', default: false })
  online!: boolean;

  @Column({ type: 'timestamptz', name: 'last_seen_at', nullable: true })
  lastSeenAt!: Date | null;

  @Index()
  @Column({ type: 'uuid', name: 'zone_id', nullable: true })
  zoneId!: string | null;

  @ManyToOne(() => ZoneEntity, (zone) => zone.nodes, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'zone_id' })
  zone!: ZoneEntity | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

@Entity({ name: 'node_updates' })
@Index('ix_node_updates_node_started', ['nodeId', 'startedAt'])
export class NodeUpdateEntity {
  /** Also the `update` command's id, which the node echoes on every status. */
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'node_id' })
  nodeId!: string;

  @ManyToOne(() => NodeEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'node_id',
    foreignKeyConstraintName: 'fk_node_updates_node',
  })
  node!: NodeEntity;

  @Column({ type: 'text' })
  app!: AgentApp;

  @Column({ type: 'text', name: 'from_version', nullable: true })
  fromVersion!: string | null;

  @Column({ type: 'text', name: 'to_version' })
  toVersion!: string;

  @Column({ type: 'boolean', name: 'is_roll_back' })
  isRollBack!: boolean;

  @Column({ type: 'text', name: 'last_state', nullable: true })
  lastState!: UpdateState | null;

  @Column({ type: 'text' })
  outcome!: NodeUpdateOutcome;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'timestamptz', name: 'started_at' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt!: Date | null;
}

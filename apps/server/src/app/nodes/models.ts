import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { NodeKind, NodeStatus, type NodeCapabilities } from '@tempestas/domain';
import { ZoneEntity } from '../zones/models';

@Entity({ name: 'nodes' })
export class NodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Immutable after admission: it is the MQTT topic segment and the ACL subject.
   * Renaming it would orphan the node's whole topic subtree. `displayName` is
   * the editable one.
   */
  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ type: 'text', name: 'display_name' })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  location!: string | null;

  /** Display only. Nothing in the server may branch on this. */
  @Column({ type: 'enum', enum: NodeKind, default: NodeKind.RaspberryPi })
  kind!: NodeKind;

  /**
   * An unknown node that says hello lands here as `pending`: it receives no
   * commands and its readings are discarded until a human admits it. A stray
   * ESP32 on the LAN must not be able to inject a reading that starts a burner.
   */
  @Column({ type: 'enum', enum: NodeStatus, default: NodeStatus.Pending })
  status!: NodeStatus;

  @Column({ type: 'jsonb' })
  capabilities!: NodeCapabilities;

  @Column({ type: 'text', name: 'agent_version', nullable: true })
  agentVersion!: string | null;

  /**
   * Changes on every restart of the node's agent, so a bounce is detectable
   * across a restart of the SERVER too - which is why it is a column and not
   * an in-memory map. Phase 7 uses a changed bootId to re-assert pin state.
   */
  @Column({ type: 'text', name: 'boot_id', nullable: true })
  bootId!: string | null;

  /** Driven by the retained LWT, persisted so the list view is one query. */
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

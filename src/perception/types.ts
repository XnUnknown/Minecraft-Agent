/** Structured world-state types produced by Perception and stored on the Blackboard. */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type EntityKind = 'hostile' | 'neutral' | 'passive' | 'player' | 'object' | 'other';

export interface PerceivedEntity {
  id: number;
  name: string;
  kind: EntityKind;
  position: Vec3Like;
  /** Distance from the bot, in blocks. */
  distance: number;
  /** 8-point compass direction from the bot (N, NE, E, ...). */
  direction: string;
  health?: number;
}

export interface SelfState {
  position: Vec3Like;
  health: number;
  food: number;
  dimension: string;
  onGround: boolean;
  inWater: boolean;
  heldItem: string | null;
}

export interface EnvironmentState {
  biome: string;
  timeOfDay: number;
  isDay: boolean;
  raining: boolean;
}

export interface InventoryItem {
  name: string;
  count: number;
}

/** A complete snapshot of what the agent currently perceives. */
export interface WorldState {
  updatedAt: number;
  self: SelfState;
  inventory: InventoryItem[];
  players: string[];
  entities: PerceivedEntity[];
  environment: EnvironmentState;
}

/** A distinct non-terrain block type spotted nearby, e.g. a specific ore or wood variant. */
export interface NearbyBlock {
  name: string;
  count: number;
  distance: number;
  direction: string;
}

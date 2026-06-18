import type { WorldState } from '../perception/types';

/**
 * The single source of truth for current world state. Perception writes to it (~3 Hz);
 * the GoalRunner reads from it, and from Stage 5 the Reflex Layer will too. Decoupling
 * every consumer through this object keeps subsystems independent and testable.
 */
export class Blackboard {
  private state: WorldState | null = null;

  set(state: WorldState): void {
    this.state = state;
  }

  get(): WorldState | null {
    return this.state;
  }
}

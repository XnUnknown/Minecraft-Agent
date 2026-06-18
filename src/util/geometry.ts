import type { Vec3Like } from '../perception/types';

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * 8-point compass direction from `from` to `to` using Minecraft axes
 * (+X = east, +Z = south, -Z = north). Returns 'here' when essentially co-located.
 */
export function compassDirection(from: Vec3Like, to: Vec3Like): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return 'here';
  // 0 deg = north (-Z), increasing clockwise toward east (+X).
  let ang = (Math.atan2(dx, -dz) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  return DIRS[Math.round(ang / 45) % 8];
}

export function round(n: number): number {
  return Math.round(n);
}

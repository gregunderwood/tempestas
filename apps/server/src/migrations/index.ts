/**
 * Every migration, listed explicitly and in order.
 *
 * A webpack bundle has no directory to scan, so the glob the TypeORM CLI uses
 * cannot work inside the shipped artifact. Adding a migration means adding it
 * here; forgetting leaves a schema change that runs in development and
 * silently does not on the Pi.
 */
export { InitialSchema1788917132521 } from './1788917132521-InitialSchema';
export { AddNodeBootId1788923106173 } from './1788923106173-AddNodeBootId';
export { ScopeReadingDedupeToBoot1788925934987 } from './1788925934987-ScopeReadingDedupeToBoot';

/**
 * @tempestas/domain - the shared contract between the Angular app, the NestJS
 * API and the Python node agents.
 *
 * INVARIANT: this library contains interfaces, enums and const objects ONLY.
 * Zero decorators, zero framework imports. NestJS DTO classes live in the
 * server and `implements` these interfaces, so class-validator never reaches
 * the browser bundle while the two sides are still checked against one shape.
 * The eslint module boundary enforces it.
 */
export * from './lib/nodes/node.model';
export * from './lib/zones/zone.model';
export * from './lib/devices/device.model';
export * from './lib/readings/reading.model';
export * from './lib/rules/rules.model';
export * from './lib/errors/api-error.model';
export * from './lib/hardware/mqtt-contract';
export * from './lib/ui/gauge-metrics';

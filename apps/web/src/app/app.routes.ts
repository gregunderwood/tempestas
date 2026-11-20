import { Route } from '@angular/router';

/**
 * Lazy standalone components throughout. `/nodes` was a dead nav link in the old
 * app for years; here it is a real route from the beginning.
 */
export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard - tempestas',
    loadComponent: () =>
      import('./features/dashboard/dashboard').then(
        (module) => module.Dashboard,
      ),
  },
  {
    path: 'readings',
    title: 'Readings - tempestas',
    loadComponent: () =>
      import('./features/readings/readings-page').then(
        (module) => module.ReadingsPage,
      ),
  },
  {
    path: 'zones',
    title: 'Zones - tempestas',
    loadComponent: () =>
      import('./features/zones/zones-page').then((module) => module.ZonesPage),
  },
  {
    path: 'devices',
    title: 'Devices - tempestas',
    loadComponent: () =>
      import('./features/devices/devices-page').then(
        (module) => module.DevicesPage,
      ),
  },
  {
    path: 'nodes/:slug',
    title: 'Node - tempestas',
    loadComponent: () =>
      import('./features/nodes/node-detail').then(
        (module) => module.NodeDetail,
      ),
  },
  {
    path: 'nodes',
    title: 'Nodes - tempestas',
    loadComponent: () =>
      import('./features/nodes/nodes-page').then((module) => module.NodesPage),
  },
  { path: '**', redirectTo: 'dashboard' },
];

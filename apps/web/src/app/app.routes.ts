import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard - tempestas',
    data: {
      heading: 'Dashboard',
      subtitle: 'Every zone, node and relay, live',
    },
    loadComponent: () =>
      import('./features/dashboard/dashboard').then(
        (module) => module.Dashboard,
      ),
  },
  {
    path: 'reports',
    title: 'Reports - tempestas',
    data: {
      heading: 'Reports',
      subtitle: 'How the nights went, and how hard the equipment worked',
    },
    loadComponent: () =>
      import('./features/reports/reports-page').then(
        (module) => module.ReportsPage,
      ),
  },
  { path: 'readings', redirectTo: 'reports' },
  {
    path: 'zones',
    title: 'Zones - tempestas',
    data: {
      heading: 'Zones',
      subtitle: 'What each zone sees, and what its rules decided',
    },
    loadComponent: () =>
      import('./features/zones/zones-page').then((module) => module.ZonesPage),
  },
  {
    path: 'devices',
    title: 'Devices - tempestas',
    data: {
      heading: 'Devices',
      subtitle: 'Every relay, its state and its automation',
    },
    loadComponent: () =>
      import('./features/devices/devices-page').then(
        (module) => module.DevicesPage,
      ),
  },
  {
    path: 'nodes/:slug',
    title: 'Node - tempestas',
    data: {
      heading: 'Node',
      subtitle: 'Live readings and day and night statistics',
    },
    loadComponent: () =>
      import('./features/nodes/node-detail').then(
        (module) => module.NodeDetail,
      ),
  },
  {
    path: 'nodes',
    title: 'Nodes - tempestas',
    data: { heading: 'Nodes', subtitle: 'Every box that has announced itself' },
    loadComponent: () =>
      import('./features/nodes/nodes-page').then((module) => module.NodesPage),
  },
  { path: '**', redirectTo: 'dashboard' },
];

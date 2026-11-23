import { Module } from '@nestjs/common';
import { join } from 'node:path';
import { AgentReleasesController } from './agent-releases.controller';
import {
  AGENT_RELEASES_DIRECTORY,
  AgentReleasesService,
} from './agent-releases.service';

// Beside the releases rather than in one, so a server rollback keeps the agents' bundles; the units run from ~/tempestas.
const DEFAULT_AGENT_RELEASES_DIRECTORY = join(process.cwd(), 'agent-releases');

@Module({
  controllers: [AgentReleasesController],
  providers: [
    AgentReleasesService,
    {
      provide: AGENT_RELEASES_DIRECTORY,
      useValue: DEFAULT_AGENT_RELEASES_DIRECTORY,
    },
  ],
  exports: [AgentReleasesService],
})
export class AgentReleasesModule {}

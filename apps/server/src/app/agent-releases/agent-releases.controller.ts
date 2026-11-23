import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { AgentRelease } from '@tempestas/domain';
import { MANIFEST_FILE } from './agent-release-bundles';
import { AgentReleasesService } from './agent-releases.service';

const BINARY_CONTENT_TYPE = 'application/octet-stream';

// Read-only, and only the files a verified manifest lists: a node checks every byte against the manifest anyway.
@Controller('agent-releases')
export class AgentReleasesController {
  // Named, so the HTTP test can build it: vitest emits no decorator metadata.
  constructor(
    @Inject(AgentReleasesService)
    private readonly agentReleases: AgentReleasesService,
  ) {}

  @Get()
  list(): AgentRelease[] {
    return this.agentReleases.list();
  }

  // The manifest's own bytes, never re-serialised: an `update` command pins their sha256.
  @Get(`:app/:version/${MANIFEST_FILE}`)
  @Header('Content-Type', 'application/json')
  readManifest(
    @Param('app') app: string,
    @Param('version') version: string,
  ): StreamableFile {
    return new StreamableFile(
      createReadStream(this.requireBundle(app, version).manifestFile),
    );
  }

  @Get(':app/:version/files/*path')
  @Header('Content-Type', BINARY_CONTENT_TYPE)
  readFile(
    @Param('app') app: string,
    @Param('version') version: string,
    @Param('path') pathSegments: string[],
  ): StreamableFile {
    const path = pathSegments.join('/');
    const onDisk = this.requireBundle(app, version).filesByPath.get(path);
    if (!onDisk) {
      throw new NotFoundException(`${app} ${version} has no file ${path}`);
    }
    return new StreamableFile(createReadStream(onDisk));
  }

  private requireBundle(app: string, version: string) {
    const bundle = this.agentReleases.findBundle(app, version);
    if (!bundle) {
      throw new NotFoundException(`No release bundle for ${app} ${version}`);
    }
    return bundle;
  }
}

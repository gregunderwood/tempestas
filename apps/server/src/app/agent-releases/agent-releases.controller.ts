import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { ApiErrorCode, type AgentRelease } from '@tempestas/domain';
import {
  AGENT_RELEASES_ROUTE,
  MANIFEST_FILE,
  type AgentReleaseBundle,
} from './agent-release-bundles';
import { AgentReleasesService } from './agent-releases.service';

const BINARY_CONTENT_TYPE = 'application/octet-stream';
const JSON_CONTENT_TYPE = 'application/json';

// Read-only, and only the files a verified manifest lists: a node checks every byte against the manifest anyway.
@Controller(AGENT_RELEASES_ROUTE)
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
  @Header('Content-Type', JSON_CONTENT_TYPE)
  readManifest(
    @Param('app') app: string,
    @Param('version') version: string,
  ): StreamableFile {
    return new StreamableFile(this.requireBundle(app, version).manifestBytes);
  }

  @Get(':app/:version/files/*path')
  @Header('Content-Type', BINARY_CONTENT_TYPE)
  readFile(
    @Param('app') app: string,
    @Param('version') version: string,
    @Param('path') pathSegments: string[],
  ): StreamableFile {
    const path = pathSegments.join('/');
    const bytes = this.requireBundle(app, version).filesByPath.get(path);
    if (!bytes) {
      throw bundleNotFound(`${app} ${version} has no file ${path}`);
    }
    return new StreamableFile(bytes);
  }

  private requireBundle(app: string, version: string): AgentReleaseBundle {
    const bundle = this.agentReleases.findBundle(app, version);
    if (!bundle) {
      throw bundleNotFound(`No release bundle for ${app} ${version}`);
    }
    return bundle;
  }
}

function bundleNotFound(message: string): NotFoundException {
  return new NotFoundException({ code: ApiErrorCode.NotFound, message });
}

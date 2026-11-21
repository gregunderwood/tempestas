import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import type { Node } from '@tempestas/domain';
import { NodesService } from './nodes.service';
import { AdmitNodeDto } from './dto/admit-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';

// No POST: a node exists by announcing itself on MQTT, and the only thing a human does is admit it.
@Controller('nodes')
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get()
  findAll(): Promise<Node[]> {
    return this.nodes.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Node> {
    return this.nodes.findOne(id);
  }

  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() changes: UpdateNodeDto,
  ): Promise<Node> {
    return this.nodes.update(id, changes);
  }

  @Post(':id/admit')
  @HttpCode(200)
  admit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() admission: AdmitNodeDto,
  ): Promise<Node> {
    return this.nodes.admit(id, admission);
  }

  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id', ParseUUIDPipe) id: string): Promise<Node> {
    return this.nodes.disable(id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.nodes.remove(id);
  }
}

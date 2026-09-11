import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { Device } from '@tempestas/domain';
import { DevicesService } from './devices.service';
import { PinTransitionLog } from './pin-transition-log.service';
import type { PinTransitionEntity } from './models';
import { CreateDeviceDto } from './dto/create-device.dto';
import { PatchDeviceRulesDto, UpdateDeviceDto } from './dto/update-device.dto';

/**
 * Errors leave as real HTTP status codes with a machine-readable `code`.
 * The old API returned `{ error: "..." }` inside a 200 body, which is why the
 * Angular client had four near-identical `if (res.error)` blocks and no
 * interceptor anywhere.
 */
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly transitions: PinTransitionLog,
  ) {}

  @Get()
  findAll(): Promise<Device[]> {
    return this.devices.findAll();
  }

  /**
   * Relay history, for fitting the climate model against real behaviour.
   *
   * Declared BEFORE `:id`, or Express matches "transitions" as a device id and
   * the UUID pipe rejects it with a validation error that looks like a bug in
   * the caller.
   */
  @Get('transitions')
  transitionHistory(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('nodeId') nodeId?: string,
    @Query('limit') limit?: string,
  ): Promise<PinTransitionEntity[]> {
    return this.transitions.query({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      nodeId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  create(@Body() dto: CreateDeviceDto): Promise<Device> {
    return this.devices.create(dto);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Device> {
    return this.devices.findOne(id);
  }

  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeviceDto,
  ): Promise<Device> {
    return this.devices.update(id, dto);
  }

  @Patch(':id')
  patchRules(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchDeviceRulesDto,
  ): Promise<Device> {
    return this.devices.setRulesEnabled(id, dto.rulesEnabled);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.devices.remove(id);
  }

  @Post(':id/on')
  @HttpCode(200)
  turnOn(@Param('id', ParseUUIDPipe) id: string): Promise<Device> {
    return this.devices.turnOn(id);
  }

  @Post(':id/off')
  @HttpCode(200)
  turnOff(@Param('id', ParseUUIDPipe) id: string): Promise<Device> {
    return this.devices.turnOff(id);
  }

  @Post(':id/force-on')
  @HttpCode(200)
  forceOn(@Param('id', ParseUUIDPipe) id: string): Promise<Device> {
    return this.devices.forceOn(id);
  }
}

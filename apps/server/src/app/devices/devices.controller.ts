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

  // Declared before `:id`, or the UUID pipe rejects "transitions" as a device id.
  @Get('transitions')
  transitionHistory(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('nodeId') nodeId?: string,
    @Query('limit') limit?: string,
  ): Promise<PinTransitionEntity[]> {
    return this.transitions.query({
      from: parseOptionalDate(from),
      to: parseOptionalDate(to),
      nodeId,
      limit: parseOptionalNumber(limit),
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

function parseOptionalDate(text?: string): Date | undefined {
  return text ? new Date(text) : undefined;
}

function parseOptionalNumber(text?: string): number | undefined {
  return text ? Number(text) : undefined;
}

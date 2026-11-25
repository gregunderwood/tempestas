import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ApiErrorCode } from '@tempestas/domain';
import { HardwareError } from './hardware.service';

export function translateHardwareError(error: unknown): unknown {
  return error instanceof HardwareError ? toHttpError(error) : error;
}

// A dead transport is a 503: the server cannot act. Anything else is the physical world saying no.
function toHttpError(
  hardwareError: HardwareError,
): ConflictException | ServiceUnavailableException {
  const body = { code: hardwareError.code, message: hardwareError.message };
  return hardwareError.code === ApiErrorCode.HardwareUnreachable
    ? new ServiceUnavailableException(body)
    : new ConflictException(body);
}

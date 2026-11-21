import { MILLISECONDS_PER_SECOND } from './time-units';

export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  set(instant: Date): void {
    this.current = instant;
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(
      this.current.getTime() + seconds * MILLISECONDS_PER_SECOND,
    );
  }
}

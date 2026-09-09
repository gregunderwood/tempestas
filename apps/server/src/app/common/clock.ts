export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** Test double. Lets every time-dependent behaviour be asserted exactly. */
export class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  set(d: Date): void {
    this.current = d;
  }
  advanceSeconds(s: number): void {
    this.current = new Date(this.current.getTime() + s * 1000);
  }
}

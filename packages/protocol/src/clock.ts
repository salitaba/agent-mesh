export interface Clock {
  now(): Date;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  iso: () => new Date().toISOString(),
};

export class FixedClock implements Clock {
  private ms: number;
  constructor(startISO: string | number = "2026-01-01T00:00:00.000Z") {
    this.ms = typeof startISO === "number" ? startISO : Date.parse(startISO);
  }
  now(): Date {
    return new Date(this.ms);
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}

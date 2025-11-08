import { SensorType } from "../types";

export abstract class Sensor {
  abstract id: string;
  abstract type: SensorType;
  abstract pollingTime: number;
  abstract pollingWaitTime: number;
  abstract log: boolean;

  init?(opts: unknown): Promise<void>;

  abstract readValue(): Promise<number | boolean>;
}

export const isSensor = (x: unknown): x is Sensor =>
  !!x &&
  typeof (x as any).id === "string" &&
  typeof (x as any).read === "function";

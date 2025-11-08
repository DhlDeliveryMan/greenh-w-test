import fs from "fs";
import { EventEmitter } from "node:events";
import { extname } from "path";
import { Sensor } from "./sensors/Sensor";
import { SensorReading } from "./types";

type MaybeSensor = Sensor & {
  id: string;
  init?: (opts?: unknown) => any;
  readValue?: () => any;
};

export class SensorHandler extends EventEmitter {
  validExtensions = [".ts", ".js"];
  ignoreFiles = ["Sensor.ts"];

  config: Record<string, unknown> = {
    cpuTemp: { unit: "°C" },
  };

  sensors = new Map<string, MaybeSensor>();
  private pollingTimers = new Map<string, NodeJS.Timeout>();
  private latestReadings = new Map<string, SensorReading>();

  private isCtor(v: unknown): v is new (...a: any[]) => any {
    return (
      typeof v === "function" &&
      /^class\s/.test(Function.prototype.toString.call(v))
    );
  }

  private isSensorInstance(v: unknown): v is MaybeSensor {
    const s = v as MaybeSensor;
    return !!s && typeof s.id === "string";
  }

  async loadSensors() {
    const dir = `${process.cwd()}/src/sensors/`;
    const files = fs
      .readdirSync(dir)
      .filter(
        (f) =>
          this.validExtensions.includes(extname(f).toLowerCase()) &&
          !this.ignoreFiles.includes(f)
      );

    for (const file of files) {
      const mod = await import(process.cwd() + `/src/sensors/${file}`);
      const D = mod.default ?? mod;

      let instance: MaybeSensor | null = null;
      if (this.isCtor(D)) instance = new D();
      else if (this.isSensorInstance(D)) instance = D;

      if (this.isSensorInstance(instance)) {
        await instance.init?.(this.config[instance.id]);
        this.sensors.set(instance.id, instance);
        console.log(`[Handler] Loaded sensor: ${instance.id}`);
      }
    }
  }

  async runAll() {
    for (const sensor of this.sensors.values()) {
      await this.readSensor(sensor);
    }
  }

  startPolling() {
    for (const sensor of this.sensors.values()) {
      if (this.pollingTimers.has(sensor.id)) continue;
      const initialDelay = Math.max(sensor.pollingWaitTime ?? 0, 0);
      this.scheduleNextPoll(sensor, initialDelay);
    }
  }

  stopPolling(id: string) {
    const timer = this.pollingTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.pollingTimers.delete(id);
  }

  stopAllPolling() {
    for (const id of this.pollingTimers.keys()) {
      this.stopPolling(id);
    }
  }

  private scheduleNextPoll(sensor: MaybeSensor, delay: number) {
    const timeout = setTimeout(async () => {
      this.pollingTimers.delete(sensor.id);
      await this.readSensor(sensor);
      const nextDelay = Math.max(sensor.pollingTime ?? 0, 0);
      this.scheduleNextPoll(sensor, nextDelay);
    }, delay);

    this.pollingTimers.set(sensor.id, timeout);
  }

  private async readSensor(sensor: MaybeSensor) {
    if (!sensor.readValue) return;
    try {
      const value = await sensor.readValue();
      const reading: SensorReading = {
        id: sensor.id,
        type: sensor.type,
        value,
        timestamp: new Date().toISOString(),
      };

      this.latestReadings.set(sensor.id, reading);
      if (sensor.log) console.log(`[Handler] Read ${sensor.id}: ${value}`);
      this.emit("reading", reading);
    } catch (err) {
      console.error(`[Handler] Failed to read ${sensor.id}`, err);
    }
  }

  getCachedReadings(): SensorReading[] {
    return Array.from(this.latestReadings.values());
  }
}

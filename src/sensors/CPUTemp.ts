import { SensorHandler } from "../sensorHandler";
import { SensorType } from "../types";
import { Sensor } from "./Sensor";
import { cpuTemperature } from "systeminformation";

export default class CPUTemp extends Sensor {
  id: string = "cpuTemp";
  type: SensorType = "air_temperature";

  // polling time in miliseconds
  pollingTime: number = 2000;
  pollingWaitTime: number = 0;
  log = false;

  init(opts: unknown): Promise<void> {
    return Promise.resolve();
  }

  readValue(): Promise<number | boolean> {
    return new Promise((resolve, reject) => {
      cpuTemperature()
        .then((data) => {
          resolve(data.main);
        })
        .catch((err) => {
          reject(false);
        });
    });
  }
}

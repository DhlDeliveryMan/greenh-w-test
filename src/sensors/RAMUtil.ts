import { SensorType } from "../types";
import { Sensor } from "./Sensor";
import { mem } from "systeminformation";

export default class CPUUtil extends Sensor {
  id: string = "ramUtil";
  type: SensorType = "utitlization";

  pollingTime: number = 2000;
  pollingWaitTime: number = 0;
  log = false;

  readValue(): Promise<number | boolean> {
    return new Promise(async (resolve, reject) => {
      await mem()
        .then(({ active, total }) => {
          resolve((active / total) * 100);
        })
        .catch((err) => {
          reject(false);
        });
    });
  }
}

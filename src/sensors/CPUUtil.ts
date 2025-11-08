import { SensorType } from "../types";
import { Sensor } from "./Sensor";
import { currentLoad } from "systeminformation";

export default class CPUUtil extends Sensor {
  id: string = "cpuUtil";
  type: SensorType = "utitlization";

  pollingTime: number = 2000;
  pollingWaitTime: number = 0;
  log = false;

  readValue(): Promise<number | boolean> {
    return new Promise(async (resolve, reject) => {
      await currentLoad()
        .then((data) => {
          resolve(data.currentLoad);
        })
        .catch((err) => {
          reject(false);
        });
    });
  }
}

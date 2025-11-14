export type Actuator = "fan" | "pump" | "light" | "climate";

export interface Command {
  cmd:
    | "set_stage"
    | "manual_override"
    | "enable_auto"
    | "who"
    | "ping"
    | "warning";
  id?: string;
  stage?: number;
  actuator?: Actuator;
  value?: boolean | number;
  payload?: Record<string, unknown>;
}

export interface EventMessage {
  event: "sensor_update" | "actuator_state" | "ack";
  data: any;
}

export type Status = "connected" | "disconnected" | "fail";

export type SensorType =
  | "temperature"
  | "humidity"
  | "soil_moisture"
  | "co2"
  | "TVOC"
  | "humidity"
  | "air_temperature"
  | "water_flow"
  | "switch_position"
  | "utitlization";

export interface SensorReading {
  id: string;
  type: SensorType;
  value: number | boolean;
  timestamp: string;
}

export type AltertType =
  | "overtemp"
  | "undertemp"
  | "fan_failure"
  | "high_humidity"
  | "high_co2"
  | "power_failure";

export interface IAlert {
  id: string;
  type: AltertType;
  location: string;
  severity: "low" | "medium" | "high" | "informative";
  message: string;
  timestamp: number;
  sensorId?: number;
  threshold?: number;
  currentValue?: number;
}

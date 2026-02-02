export type Actuator = "fan" | "pump" | "light" | "climate";

export interface Command {
  cmd:
    | "set_stage"
    | "manual_override"
    | "enable_auto"
    | "who"
    | "ping"
    | "warning"
    | "pwm"
    | string;
  id?: string;
  stage?: number;
  actuator?: Actuator;
  value?: boolean | number;
  payload?: Record<string, unknown> | PWMPayload;
  node?: string;
}

export interface EventMessage {
  event: "sensor_update" | "actuator_state" | "ack";
  data: any;
}

export type Status = "connected" | "disconnected" | "fail";

export type SensorType =
  | "temperature"
  | "air_temperature"
  | "humidity"
  | "soil_moisture"
  | "co2"
  | "tvoc"
  | "water_temp"
  | "water_level"
  | "water_flow"
  | "switch_position"
  | "utilization"
  | "panel_state"
  | string;

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

export interface PWMPayload {
  pin: number | string;
  frequency?: number; // Hz
  duty: number; // 0..1 (fractional) or 0..100 depending on node
  durationMs?: number; // optional duration to run PWM
}

export interface PWMCommand {
  cmd: "pwm";
  id?: string;
  node?: string;
  payload: PWMPayload;
}
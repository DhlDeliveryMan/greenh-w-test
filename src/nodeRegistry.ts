export type NodeId = "esp32-main" | "nano-tec" | "nano-panel" | string;

export type Capability = {
  sensors?: string[]; // sensor ids/types hosted on this node
  actuators?: string[]; // actuator ids/types hosted on this node
  notes?: string;
};

const registry: Record<NodeId, Capability> = {
  "esp32-main": {
    sensors: ["co2", "tvoc", "aqi", "soil_moisture", "enclosure_temp", "enclosure_hum", "water_temp_cold", "water_temp_hot", "water_temp_inlet", "water_temp_outlet"],
    actuators: ["pump_irrigation", "fan_greenhouse", "light_cct_warm", "light_cct_cool"],
    notes: "Main greenhouse node handling irrigation pump, fans, and CCT lights",
  },
  "nano-tec": {
    sensors: ["tec_cold_temp", "tec_hot_temp", "water_level_tank_a", "water_level_tank_b", "water_level_tank_c"],
    actuators: ["tec_peltier", "tec_pump", "fan_tec"],
    notes: "TEC control node",
  },
  "nano-panel": {
    sensors: ["panel_state"],
    actuators: ["panel_display"],
    notes: "Panel inputs/displays over RS485 if used; optional when Pi handles panel locally",
  },
};

export function getNodeCapabilities(id: NodeId): Capability | undefined {
  return registry[id];
}

export function listNodes(): Array<{ id: NodeId; capability: Capability }> {
  return Object.entries(registry).map(([id, capability]) => ({ id: id as NodeId, capability }));
}

export function registerNode(id: NodeId, capability: Capability) {
  registry[id] = capability;
}

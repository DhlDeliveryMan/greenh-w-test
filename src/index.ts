import net from "node:net";
import fs from "node:fs";
import type types = require("./types");
import { DatabaseHandler } from "./database/database";
import { SensorHandler } from "./sensorHandler";
import { WarningHandler } from "./warningHandler";
import { uuid } from "uuidv4";
import { RS485Handler, RS485Options } from "./rs485Hanlder";
import { BusManager } from "./busManager";
import { registerDispatch, handleNodeMessage, getActuatorState, setBroadcaster, importActuatorState, setPersistFn } from "./actuatorManager";
import { PanelManager } from "./panel/panelManager";
import { panelConfig } from "./panel/config";
import { DisplayManager } from "./panel/displayManager";

const SOCKET_PATH = "/tmp/greenhouse2.sock";
type RemoteStatus = {
  connected: boolean;
  device?: string;
  speed?: number;
  lastHeartbeat?: number;
  connectedAt?: number;
  disconnectedAt?: number;
  reason?: string;
};
``
const RS485_STATUS: {
  status: types.Status;
  error?: string;
  remote: RemoteStatus;
} = {
  status: "disconnected",
  remote: {
    connected: false,
  },
};

const parseNumber = (value?: string) => {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const HEARTBEAT_TIMEOUT_MS =
  parseNumber(process.env.RS485_HEARTBEAT_TIMEOUT_MS) ?? 15000;

const RS485_DEBUG = process.env.RS485_DEBUG ?? "";

const rs485Options: RS485Options = {
  logTraffic: RS485_DEBUG !== "" && RS485_DEBUG !== "0",
  driverEnablePin: 18, // Pi GPIO18 ↔ MAX485 DE
  receiverEnablePin: 23, // Pi GPIO23 ↔ MAX485 RE
  receiverEnableActiveLow: true,
};

if (process.env.RS485_PORT) rs485Options.path = process.env.RS485_PORT;
const baudOverride = parseNumber(process.env.RS485_BAUD);
if (typeof baudOverride === "number") rs485Options.baudRate = baudOverride;

const legacyEnablePin = parseNumber(process.env.RS485_ENABLE_PIN);
const driverPinOverride = parseNumber(
  process.env.RS485_DRIVER_PIN ?? process.env.RS485_DE_PIN
);
const receiverPinOverride = parseNumber(
  process.env.RS485_RECEIVER_PIN ?? process.env.RS485_RE_PIN
);

if (typeof legacyEnablePin === "number") {
  rs485Options.enablePin = legacyEnablePin;
  rs485Options.driverEnablePin = undefined;
  rs485Options.receiverEnablePin = undefined;
} else {
  if (typeof driverPinOverride === "number") {
    rs485Options.driverEnablePin = driverPinOverride;
  }

  if (typeof receiverPinOverride === "number") {
    rs485Options.receiverEnablePin = receiverPinOverride;
  }
}

if (process.env.RS485_RE_ACTIVE_LOW) {
  rs485Options.receiverEnableActiveLow =
    process.env.RS485_RE_ACTIVE_LOW !== "0";
}

const rs485Handler = new RS485Handler(rs485Options);
const busManager = new BusManager(rs485Handler);
busManager.init().catch((err) => {
  console.error("Failed to initialize RS485 bus manager", err);
});
let heartbeatMonitorTimer: NodeJS.Timeout | undefined;

const markRemoteDisconnected = (
  reason?: string,
  overrideError = true
): boolean => {
  const remote = RS485_STATUS.remote;
  if (!remote.connected) {
    if (reason) remote.reason = reason;
    return false;
  }
  remote.connected = false;
  remote.disconnectedAt = Date.now();
  remote.reason = reason;
  if (RS485_STATUS.status === "connected") {
    RS485_STATUS.status = "disconnected";
  }
  if (reason && (overrideError || !RS485_STATUS.error)) {
    RS485_STATUS.error = reason;
  }
  return true;
};

const startHeartbeatMonitor = () => {
  if (heartbeatMonitorTimer || HEARTBEAT_TIMEOUT_MS <= 0) return;
  const interval = Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 2));
  heartbeatMonitorTimer = setInterval(() => {
    const remote = RS485_STATUS.remote;
    if (!remote.lastHeartbeat) return;
    if (!remote.connected) return;
    const age = Date.now() - remote.lastHeartbeat;
    if (age > HEARTBEAT_TIMEOUT_MS) {
      if (markRemoteDisconnected("Remote heartbeat timeout")) {
        broadcastStatusUpdate();
      }
    }
  }, interval);
};

try {
  fs.unlinkSync(SOCKET_PATH);
} catch (e) { }

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

const databaseHanlder = new DatabaseHandler();
const sensorHandler = new SensorHandler();
const warningHandler = new WarningHandler();
const panelManager = new PanelManager(panelConfig);

// Get MCP23017 0x21 driver for TM1637
const mcp21Driver = panelManager.getMCP("mcp23017-0x21");

const displayManager = new DisplayManager({
  lcd1602s: [
    { id: "lcd1", address: 0x27, device: 1 },
    { id: "lcd2", address: 0x23, device: 1 },
  ],
  tm1637: mcp21Driver ? {
    mcpChip: mcp21Driver,
    clkPin: 14, // GPB6 on 0x21
    dioPin: 15, // GPB7 on 0x21
    brightness: 4,
    digits: 6,
    digitOrder: [2, 1, 0, 5, 4, 3],
  } : undefined,
});

// ===== UNIFIED SENSOR CACHE =====
const sensorCache = new Map<string, { value: number | boolean; timestamp: string }>();

export function getLatestReading(sensorId: string): { value: number | boolean; timestamp: string } | undefined {
  return sensorCache.get(sensorId);
}

export function getAllLatestReadings(): types.SensorReading[] {
  const readings: types.SensorReading[] = [];
  for (const [id, data] of sensorCache.entries()) {
    // infer type from id or use generic; improve later if needed
    readings.push({ id, type: "temperature", value: data.value, timestamp: data.timestamp });
  }
  return readings;
}

// seed actuator store from DB and hook persistence
try {
  const rows = databaseHanlder.loadActuatorStates();
  if (rows && rows.length) {
    for (const r of rows) {
      try {
        // import without re-persisting
        // shape: { node, pin, running, duty, updated_at }
        importActuatorState({ node: r.node, pin: r.pin, running: !!r.running, duty: r.duty, updatedAt: new Date(r.updated_at).getTime() });
      } catch (e) { }
    }
  }
} catch (e) { }

setPersistFn((entry) => {
  databaseHanlder.saveActuatorState(entry);
});

const clients = new Set<net.Socket>();

// pending dispatches and actuator state are managed by actuatorManager

const isCommandMessage = (payload: unknown): payload is types.Command => {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { cmd?: unknown };
  return typeof candidate.cmd === "string";
};

const broadcast = (payload: string) => {
  for (const client of clients) {
    if (client.destroyed || !client.writable) {
      clients.delete(client);
      continue;
    }

    client.write(payload);
  }
};

// give actuatorManager a way to broadcast updates to connected clients
setBroadcaster(broadcast);

const broadcastStatusUpdate = () => {
  const payload =
    JSON.stringify({ event: "status_update", data: RS485_STATUS }) + "\n";
  broadcast(payload);
};

const handleSensorUpdate = (msg: Record<string, unknown>) => {
  const isEvent = msg.event === "sensor_update" && msg.data && typeof msg.data === "object";
  const payload = (isEvent ? (msg.data as Record<string, unknown>) : msg) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : undefined;
  const value = payload.value as number | boolean | undefined;
  const type = typeof payload.type === "string" ? payload.type : undefined;
  if (!id || value === undefined || !type) return;

  const reading: types.SensorReading = {
    id,
    type: type as types.SensorType,
    value,
    timestamp:
      typeof payload.timestamp === "string" && payload.timestamp
        ? payload.timestamp
        : new Date().toISOString(),
  };

  // Update unified cache
  sensorCache.set(reading.id, { value: reading.value, timestamp: reading.timestamp });

  try {
    databaseHanlder.saveSensorReading(reading);
  } catch (err) {
    console.error("Failed to persist RS485 sensor reading", err);
  }

  const packet = JSON.stringify({ event: "sensor_update", data: reading }) + "\n";
  broadcast(packet);
};

const handleRemotePayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const data = payload as Record<string, unknown>;
  const now = Date.now();
  const remote = RS485_STATUS.remote;
  let dirty = false;

  if (typeof data.hello === "string") {
    if (remote.device !== data.hello) {
      remote.device = data.hello;
      dirty = true;
    }
    if (typeof data.speed === "number" && remote.speed !== data.speed) {
      remote.speed = data.speed;
      dirty = true;
    }
    if (!remote.connected) {
      remote.connected = true;
      remote.connectedAt = now;
      dirty = true;
    }
    remote.lastHeartbeat = now;
    remote.disconnectedAt = undefined;
    remote.reason = undefined;
    RS485_STATUS.status = "connected";
    delete RS485_STATUS.error;
    dirty = true;
  } else if (typeof data.heartbeat === "string") {
    if (!remote.connected) {
      remote.connected = true;
      remote.connectedAt = now;
      dirty = true;
    }
    if (!remote.device) {
      remote.device = data.heartbeat;
      dirty = true;
    }
    remote.lastHeartbeat = now;
    remote.disconnectedAt = undefined;
    remote.reason = undefined;
    RS485_STATUS.status = "connected";
    delete RS485_STATUS.error;
    dirty = true;
  }

  if (dirty) {
    broadcastStatusUpdate();
  }
};

const sendAck = (
  socket: net.Socket | undefined,
  data: Record<string, unknown>
) => {
  if (!socket || socket.destroyed || !socket.writable) return;
  socket.write(JSON.stringify({ event: "ack", data }) + "\n");
};

const sendErrorEvent = (
  socket: net.Socket | undefined,
  error: Error,
  context: Record<string, unknown>
) => {
  const payload =
    JSON.stringify({
      event: "rs485_error",
      data: { ...context, message: error.message },
    }) + "\n";
  if (socket && socket.writable && !socket.destroyed) {
    socket.write(payload);
  } else {
    console.error("RS485 command error", context, error);
  }
};

rs485Handler.on("status", (status) => {
  RS485_STATUS.status = status;
  if (status === "connected") {
    delete RS485_STATUS.error;
    startHeartbeatMonitor();
  }
  if (status !== "connected") {
    markRemoteDisconnected(`RS485 link ${status}`, false);
  }
  broadcastStatusUpdate();
});

rs485Handler.on("error", (err: Error) => {
  RS485_STATUS.status = "fail";
  RS485_STATUS.error = err.message;
  markRemoteDisconnected(err.message);
  broadcastStatusUpdate();
});

rs485Handler.on("message", (payload: unknown) => {
  const packet =
    JSON.stringify({ event: "rs485_message", data: payload }) + "\n";
  broadcast(packet);
  handleRemotePayload(payload);

  if (payload && typeof payload === "object") {
    try {
      handleSensorUpdate(payload as Record<string, unknown>);
    } catch (err) {
      console.error("Failed to handle sensor_update", err);
    }
  }

  try {
    if (payload && typeof payload === "object") {
      const msg = payload as Record<string, unknown>;
      // delegate dispatch/actuator handling to actuatorManager
      handleNodeMessage(msg);
    }
  } catch (err) {
    console.error("Failed to handle node message", err);
  }
});

rs485Handler.init().catch((err) => {
  console.error("Failed to initialize RS485 handler", err);
  RS485_STATUS.status = "fail";
  RS485_STATUS.error = err.message;
});

startHeartbeatMonitor();

sensorHandler.on("reading", (reading: types.SensorReading) => {
  // Update unified cache
  sensorCache.set(reading.id, { value: reading.value, timestamp: reading.timestamp });

  try {
    databaseHanlder.saveSensorReading(reading);
  } catch (err) {
    console.error("Failed to persist sensor reading", err);
  }

  const payload =
    JSON.stringify({ event: "sensor_update", data: reading }) + "\n";
  broadcast(payload);
});

warningHandler.on("warning", (alert: types.IAlert) => {
  const payload =
    JSON.stringify({ event: "warning_issued", data: alert }) + "\n";
  broadcast(payload);
});

panelManager.on("panel_state", (state) => {
  // Log state changes for visibility in worker stdout
  // console.log("[panel] state change", JSON.stringify(state));
  try {
    const payload = JSON.stringify({ event: "panel_state", data: state }) + "\n";
    broadcast(payload);
  } catch (err) {
    console.error("Failed to broadcast panel_state", err);
  }
});

// TTL test keybindings
process.stdin.on("data", (input: string | Buffer) => {
  const str = typeof input === "string" ? input : input.toString("utf8");
  if (str === "\u0003") process.exit(); // Ctrl+C
  const key = str.trim();

  if (key === "c") {
    const warning = warningHandler.addWarning({
      id: uuid(),
      type: "overtemp",
      location: "greenhouse-1",
      severity: "high",
      message: "Test overtemperature alert",
      timestamp: Date.now(),
      threshold: 30,
      currentValue: 35,
    });

    warningHandler.issueWarning(warning);
  }
  if (key === "w") {
    busManager
      .request({ cmd: "who" }, 3000)
      .then((reply) =>
        console.log("[RS485] who response", JSON.stringify(reply))
      )
      .catch((err) => console.error("Failed to send RS485 who command", err));
  }
  if (key === "p") {
    console.log("Sending ping...");
    busManager
      .request({ cmd: "ping", node: 'nano-panel' }, 3000)
      .then((reply) =>
        console.log("[RS485] ping response", JSON.stringify(reply))
      )
      .catch((err) => console.error("Failed to send RS485 ping command", err));
  }
  if (key === "a") {
    // example: trigger PWM on node-01 pin 5, 60% duty, 500Hz for 10s
    busManager
      .sendPWM("nano-panel", 3, 0.7, 10000, 10000)
      .then((reply) => console.log("[RS485] pwm response", JSON.stringify(reply)))
      .catch((err) => console.error("Failed to send PWM command", err));
    // busManager
    //   .sendPWM("esp-main", 33, 1, 10000, 30000)
    //   .then((reply) => console.log("[RS485] pwm response", JSON.stringify(reply)))
    //   .catch((err) => console.error("Failed to send PWM command", err));
  }
  if (key === 't') {
    busManager
      .request({ cmd: "readCO2", node: 'esp-main' }, 5000)
      .then((reply) =>
        console.log("[RS485] temp response", JSON.stringify(reply))
      )
      .catch((err) => console.error("Failed to send RS485 ping command", err));
  }
});

const server = net.createServer((socket) => {
  console.log("Client connected");
  clients.add(socket);

  socket.write(
    JSON.stringify({ event: "status_update", data: RS485_STATUS }) + "\n"
  );

  for (const reading of sensorHandler.getCachedReadings()) {
    socket.write(
      JSON.stringify({ event: "sensor_update", data: reading }) + "\n"
    );
  }

  for (const warning of warningHandler.getWarnings()) {
    // console.log("Sending warning to new client", warning);
    socket.write(
      JSON.stringify({ event: "warning_issued", data: warning }) + "\n"
    );
  }

  socket.on("data", (data) => {
    const messages = data.toString().split("\n").filter(Boolean);

    messages.forEach((raw) => {
      try {
        const msg = JSON.parse(raw);
        if (isCommandMessage(msg)) {
          const packet: types.Command = {
            ...msg,
            id: (msg as any).id ?? (msg as any).uuid ?? uuid(),
          };

          // Allow clients to query current actuator state
          if (packet.cmd === "get_actuator_state") {
            try {
              const nodeQ = (packet as any).node as string | undefined;
              const pinQ = (packet as any).payload?.pin as number | string | undefined;
              const state = getActuatorState(nodeQ, pinQ);
              sendAck(socket, { cmd: packet.cmd, id: packet.id, state });
            } catch (err) {
              sendErrorEvent(socket, err as Error, { cmd: packet.cmd, id: packet.id });
            }
            return;
          }

          // For actuator/pwm commands, avoid an automatic timeout because
          // the node may take time to perform the operation and then reply.
          if (packet.cmd === "pwm") {
            // Register this dispatch so we can forward later replies or
            // actuator_state events to the originating client.
            const idRaw = String(packet.id ?? "");
            const id = idRaw.replace(/^0+(?=\d)/, "");
            const expectedPin = (packet as any).payload?.pin ?? (packet as any).payload?.payload?.pin ?? null;
            registerDispatch(id, socket, expectedPin, 60000);

            // Dispatch PWM as fire-and-forget so it doesn't block the queued
            // request pipeline. Acknowledgement to client indicates dispatch,
            // node may still emit actuator_state or a reply later.
            busManager
              .sendNoReply(packet as any)
              .then(() => sendAck(socket, { cmd: packet.cmd, id: packet.id, dispatched: true }))
              .catch((err) =>
                sendErrorEvent(socket, err as Error, {
                  cmd: packet.cmd,
                  id: packet.id,
                })
              );
          } else {
            busManager
              .request(packet as any)
              .then((reply) =>
                sendAck(socket, { cmd: packet.cmd, id: packet.id, reply })
              )
              .catch((err) =>
                sendErrorEvent(socket, err as Error, {
                  cmd: packet.cmd,
                  id: packet.id,
                })
              );
          }
        }
      } catch (err) {
        console.error("Invalid message", err);
      }
    });
  });

  socket.on("error", (err) => {
    console.error("Client error", err);
    clients.delete(socket);
  });

  socket.on("close", () => {
    clients.delete(socket);
    console.log("Client disconnected");
  });
});

server.listen(SOCKET_PATH, async () => {
  await sensorHandler.loadSensors();
  await sensorHandler.runAll();
  sensorHandler.startPolling();
  try {
    // Initialize panel manager FIRST so MCP pins are configured
    await panelManager.init();
    panelManager.start();
  } catch (err) {
    console.error("Failed to start panel manager", err);
  }
  try {
    // Now display manager can use the configured MCP pins
    await displayManager.init();
  } catch (err) {
    console.error("Failed to start display manager", err);
  }
  console.log(`Worker listening on ${SOCKET_PATH}, ${server.address()}`);
});

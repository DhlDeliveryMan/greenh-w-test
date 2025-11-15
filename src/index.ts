import net from "node:net";
import fs from "node:fs";
import type types = require("./types");
import { DatabaseHandler } from "./database/database";
import { cpu, cpuTemperature } from "systeminformation";
import { SensorHandler } from "./sensorHandler";
import { WarningHandler } from "./warningHandler";
import { uuid } from "uuidv4";
import { RS485Handler, RS485Options } from "./rs485Hanlder";
import { BusManager } from "./busManager";

const SOCKET_PATH = "/tmp/greenhouse.sock";
type RemoteStatus = {
  connected: boolean;
  device?: string;
  speed?: number;
  lastHeartbeat?: number;
  connectedAt?: number;
  disconnectedAt?: number;
  reason?: string;
};

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

const RS485_DEBUG = process.env.RS485_DEBUG;

const rs485Options: RS485Options = {
  logTraffic: RS485_DEBUG ? RS485_DEBUG !== "0" : true,
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

rs485Handler.on("data", (buf) => console.log("[raw]", buf.toString("hex")));

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
} catch (e) {}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

const databaseHanlder = new DatabaseHandler();
const sensorHandler = new SensorHandler();
const warningHandler = new WarningHandler();

const clients = new Set<net.Socket>();

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

const broadcastStatusUpdate = () => {
  const payload =
    JSON.stringify({ event: "status_update", data: RS485_STATUS }) + "\n";
  broadcast(payload);
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
});

rs485Handler.init().catch((err) => {
  console.error("Failed to initialize RS485 handler", err);
  RS485_STATUS.status = "fail";
  RS485_STATUS.error = err.message;
});

startHeartbeatMonitor();

sensorHandler.on("reading", (reading: types.SensorReading) => {
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
    busManager
      .request({ cmd: "ping" }, 3000)
      .then((reply) =>
        console.log("[RS485] ping response", JSON.stringify(reply))
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
          busManager
            .request(packet)
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
  console.log(`Worker listening on ${SOCKET_PATH}, ${server.address()}`);
});

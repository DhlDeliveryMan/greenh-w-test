import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { Gpio } from "onoff";
import type { Command, Status } from "./types";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RS485Options {
  path?: string;
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "mark" | "odd" | "space";
  delimiter?: string | Buffer;
  enablePin?: number; // legacy single-pin (ties DE+RE)
  driverEnablePin?: number;
  receiverEnablePin?: number;
  receiverEnableActiveLow?: boolean;
  turnaroundDelayMs?: number;
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  logTraffic?: boolean;
}

type InternalRS485Options = Required<
  Pick<
    RS485Options,
    | "path"
    | "baudRate"
    | "dataBits"
    | "stopBits"
    | "parity"
    | "delimiter"
    | "driverEnablePin"
    | "receiverEnablePin"
    | "receiverEnableActiveLow"
    | "turnaroundDelayMs"
    | "autoReconnect"
    | "reconnectIntervalMs"
  >
> &
  RS485Options;

const DEFAULT_OPTIONS: InternalRS485Options = {
  path: "/dev/serial0",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  delimiter: "\n",
  enablePin: undefined,
  driverEnablePin: 18,
  receiverEnablePin: 23,
  receiverEnableActiveLow: true,
  turnaroundDelayMs: 2,
  autoReconnect: true,
  reconnectIntervalMs: 5000,
  logTraffic: false,
};

export class RS485Handler extends EventEmitter {
  private port?: SerialPort;
  private parser?: ReadlineParser;
  private legacyEnableGpio?: Gpio;
  private driverEnableGpio?: Gpio;
  private receiverEnableGpio?: Gpio;
  private reconnectTimer?: NodeJS.Timeout;
  private destroyed = false;
  private status: Status = "disconnected";
  private readonly options: InternalRS485Options;

  constructor(options: RS485Options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  public getStatus(): Status {
    return this.status;
  }

  public async init(): Promise<void> {
    if (this.destroyed) {
      throw new Error("Cannot initialize a destroyed RS485 handler");
    }

    this.ensureControlPins();
    await this.openPort();
  }

  public async sendRaw(payload: Buffer | string): Promise<void> {
    if (!payload || (Buffer.isBuffer(payload) && payload.length === 0)) return;
    await this.ensurePortReady();
    const buffer = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload, "utf8");

    if (this.options.logTraffic) {
      console.debug(`[RS485] => ${buffer.toString("hex")}`);
    }

    await this.driveTransceiver(true);
    try {
      await new Promise<void>((resolve, reject) => {
        this.port!.write(buffer, (err?: Error | null) =>
          err ? reject(err) : resolve()
        );
      });

      await new Promise<void>((resolve, reject) => {
        this.port!.drain((err?: Error | null) =>
          err ? reject(err) : resolve()
        );
      });
      this.emit("tx", buffer);
    } finally {
      await this.driveTransceiver(false);
      // wait briefly after switching back to RX so the transceiver settles
      if (this.options.turnaroundDelayMs > 0) {
        await sleep(this.options.turnaroundDelayMs);
      }
    }
  }

  public async sendCommand(
    command: Command | { cmd: string; id: string }
  ): Promise<void> {
    const serialized = JSON.stringify(command);
    const delimiterBuffer = Buffer.isBuffer(this.options.delimiter)
      ? this.options.delimiter
      : Buffer.from(this.options.delimiter ?? "\n", "utf8");

    const payload = Buffer.concat([
      Buffer.from(serialized, "utf8"),
      delimiterBuffer,
    ]);

    if (this.options.logTraffic) {
      console.debug(`[RS485] => ${serialized}`);
    }

    await this.sendRaw(payload);
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.clearReconnectTimer();
    await this.closePort();
    this.releaseGpio(this.legacyEnableGpio, "DE/RE");
    this.legacyEnableGpio = undefined;
    this.releaseGpio(this.driverEnableGpio, "DE");
    this.driverEnableGpio = undefined;
    this.releaseGpio(this.receiverEnableGpio, "RE");
    this.receiverEnableGpio = undefined;
  }

  private async ensurePortReady(): Promise<void> {
    if (this.port && this.port.isOpen) return;
    await this.openPort();
  }

  private async openPort(): Promise<void> {
    if (this.port?.isOpen) return;

    this.port = new SerialPort({
      path: this.options.path,
      baudRate: this.options.baudRate,
      dataBits: this.options.dataBits,
      stopBits: this.options.stopBits,
      parity: this.options.parity,
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      this.port!.open((err?: Error | null) => (err ? reject(err) : resolve()));
    }).catch((err: Error) => {
      this.setStatus("fail", err);
      this.scheduleReconnect();
      throw err;
    });

    this.attachSerialListeners();
    this.setStatus("connected");
  }

  private attachSerialListeners() {
    if (!this.port) return;

    this.port.on("error", (err: Error) => this.handlePortError(err));
    this.port.on("close", () => {
      this.setStatus("disconnected");
      this.scheduleReconnect();
    });

    if (this.parser) {
      this.parser.removeAllListeners();
      this.parser.destroy();
      this.parser = undefined;
    }

    if (this.options.delimiter) {
      const parser = this.port.pipe(
        new ReadlineParser({ delimiter: this.options.delimiter })
      );
      this.parser = parser;
      parser.on("data", (data: string | Buffer) => this.handleIncoming(data));
    } else {
      this.port.on("data", (data: Buffer) => this.handleIncoming(data));
    }
  }

  private handleIncoming(data: Buffer | string) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");

    if (!buffer.length) return;

    this.emit("data", buffer);

    const asString = buffer.toString("utf8").trim();
    if (asString.length) {
      if (this.options.logTraffic) {
        console.debug(`[RS485] <= ${asString}`);
      }
      this.emit("line", asString);
      try {
        const parsed = JSON.parse(asString);
        this.emit("message", parsed);
      } catch (err) {
        // Non JSON payloads are allowed; surface via "line" only.
      }
    } else if (this.options.logTraffic) {
      console.debug(`[RS485] <= ${buffer.toString("hex")}`);
    }
  }

  private ensureControlPins() {
    if (process.platform !== "linux") {
      console.warn(
        "[RS485] GPIO control skipped: not running on a Linux platform"
      );
      return;
    }

    const configurePin = (pin: number, label: string): Gpio | undefined => {
      try {
        return new Gpio(pin, "out");
      } catch (err) {
        console.warn(`[RS485] Failed to configure GPIO ${pin} (${label})`, err);
        return undefined;
      }
    };

    if (typeof this.options.enablePin === "number") {
      if (!this.legacyEnableGpio) {
        this.legacyEnableGpio = configurePin(this.options.enablePin, "DE/RE");
        this.legacyEnableGpio?.writeSync(0);
      }
      return;
    }

    const driverPin = this.options.driverEnablePin;
    const receiverPin = this.options.receiverEnablePin;

    if (
      typeof driverPin === "number" &&
      typeof receiverPin === "number" &&
      driverPin === receiverPin
    ) {
      if (!this.legacyEnableGpio) {
        this.legacyEnableGpio = configurePin(driverPin, "DE/RE");
        this.legacyEnableGpio?.writeSync(0);
      }
      return;
    }

    if (typeof driverPin === "number" && !this.driverEnableGpio) {
      this.driverEnableGpio = configurePin(driverPin, "DE");
      this.driverEnableGpio?.writeSync(0);
    }

    if (typeof receiverPin === "number" && !this.receiverEnableGpio) {
      this.receiverEnableGpio = configurePin(receiverPin, "RE");
      const activeLevel = this.options.receiverEnableActiveLow ? 0 : 1;
      this.receiverEnableGpio?.writeSync(activeLevel);
    }
  }

  private async driveTransceiver(transmit: boolean) {
    const toggle = (gpio: Gpio | undefined, level: 0 | 1, label: string) => {
      if (!gpio) return;
      try {
        gpio.writeSync(level);
      } catch (err) {
        console.warn(`[RS485] Failed to toggle ${label} pin`, err);
      }
    };

    if (this.driverEnableGpio) {
      toggle(this.driverEnableGpio, transmit ? 1 : 0, "DE");
    } else if (this.legacyEnableGpio) {
      toggle(this.legacyEnableGpio, transmit ? 1 : 0, "DE/RE");
    }

    if (this.receiverEnableGpio) {
      const activeLevel = this.options.receiverEnableActiveLow ? 0 : 1;
      const inactiveLevel = activeLevel === 1 ? 0 : 1;
      const level = transmit ? inactiveLevel : activeLevel;
      toggle(this.receiverEnableGpio, level, "RE");
    }
  }

  private releaseGpio(pin: Gpio | undefined, label: string) {
    if (!pin) return;
    try {
      pin.writeSync(0);
    } catch (err) {
      console.warn(
        `[RS485] Failed to drive ${label} pin low during shutdown`,
        err
      );
    }
    try {
      pin.unexport();
    } catch (err) {
      console.warn(`[RS485] Failed to unexport ${label} pin`, err);
    }
  }

  private handlePortError(error: Error) {
    this.emit("error", error);
    this.setStatus("fail");
    this.scheduleReconnect();
  }

  private setStatus(status: Status, error?: Error) {
    if (this.status === status && !error) return;
    this.status = status;
    this.emit("status", status);
    if (error) this.emit("error", error);
  }

  private scheduleReconnect() {
    if (this.destroyed || !this.options.autoReconnect) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openPort().catch((err: Error) => this.emit("error", err));
    }, this.options.reconnectIntervalMs);
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private async closePort() {
    if (!this.port) return;

    if (!this.port.isOpen) {
      this.port = undefined;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.port!.close((err?: Error | null) => (err ? reject(err) : resolve()));
    }).catch((err: Error) => this.emit("error", err));

    this.port = undefined;
    this.parser = undefined;
    this.setStatus("disconnected");
  }
}

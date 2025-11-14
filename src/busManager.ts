import { RS485Handler } from "./rs485Hanlder";
import type { Command } from "./types";

type RequestPayload = Record<string, any> & { cmd: string; id?: string };

type PendingRequest = {
  id: string;
  payload: Command & RequestPayload;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer?: NodeJS.Timeout;
};

export class BusManager {
  private readonly transport: RS485Handler;
  private initialized = false;
  private queue: PendingRequest[] = [];
  private current?: PendingRequest;
  private nextIdValue = 0;

  constructor(transport: RS485Handler) {
    this.transport = transport;
    this.handleMessage = this.handleMessage.bind(this);
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.transport.on("message", this.handleMessage);
    this.initialized = true;
  }

  public request(
    payload: RequestPayload,
    timeoutMs = 500
  ): Promise<unknown> {
    const packetId = payload.id ?? this.nextRequestId();
    const packet: Command & RequestPayload = {
      ...payload,
      id: packetId,
    };

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: packetId,
        payload: packet,
        timeoutMs,
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) return;

    this.current = next;
    try {
      await this.transport.sendCommand(next.payload);
      next.timer = setTimeout(() => this.handleTimeout(), next.timeoutMs);
    } catch (err) {
      this.resolveCurrent(err, undefined);
    }
  }

  private handleMessage(message: unknown) {
    if (!this.current || !message || typeof message !== "object") return;
    const replyToRaw = (message as Record<string, unknown>).replyTo;
    if (replyToRaw === undefined || replyToRaw === null) return;
    const replyTo = String(replyToRaw);
    if (replyTo !== this.current.id) {
      console.warn(
        `[Bus] Received reply for id=${replyTo}, expected ${this.current.id}`
      );
      return;
    }
    this.resolveCurrent(undefined, message);
  }

  private handleTimeout() {
    if (!this.current) return;
    const error = new Error(
      `RS485 request ${this.current.id} timed out after ${this.current.timeoutMs}ms`
    );
    this.resolveCurrent(error, undefined);
  }

  private resolveCurrent(error: unknown, result: unknown) {
    if (!this.current) return;
    if (this.current.timer) clearTimeout(this.current.timer);

    const { resolve, reject } = this.current;
    this.current = undefined;

    if (error) reject(error);
    else resolve(result);

    this.processQueue();
  }

  private nextRequestId(): string {
    const id = this.nextIdValue % 1000;
    this.nextIdValue = (this.nextIdValue + 1) % 1000;
    return id.toString().padStart(3, "0");
  }
}

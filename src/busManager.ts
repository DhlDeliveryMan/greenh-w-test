import { RS485Handler } from "./rs485Hanlder";
import type { Command } from "./types";

type RequestPayload = {
  cmd: string;
  id?: string;
  node?: string;
  payload?: Command["payload"];
} & Record<string, unknown>;

/**
 * Represents a pending request waiting for a response.
 * 
 * @typedef {Object} PendingRequest
 * @property {string} id - Unique identifier for the pending request
 * @property {Command & RequestPayload} payload - The command and request payload data
 * @property {number} timeoutMs - Timeout duration in milliseconds
 * @property {(value: unknown) => void} resolve - Callback function to resolve the pending request with a value
 * @property {(reason?: unknown) => void} reject - Callback function to reject the pending request with an optional reason
 * @property {NodeJS.Timeout} [timer] - Optional Node.js timeout handle for managing request timeout
 */
type PendingRequest = {
  id: string;
  payload: Command & RequestPayload;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer?: NodeJS.Timeout;
};

interface BusManagerOptions {
  interRequestDelayMs?: number;
}

export class BusManager {
  private readonly transport: RS485Handler;
  private readonly interRequestDelayMs: number;
  private initialized = false;
  private queue: PendingRequest[] = [];
  private current?: PendingRequest;
  private nextIdValue = 0;
  private nextAvailableAt = 0;
  private queueTimer?: NodeJS.Timeout;
  // serialize direct (fire-and-forget) sends so we don't toggle DE/RE concurrently
  private directSendLock: Promise<void> = Promise.resolve();

  constructor(transport: RS485Handler, options: BusManagerOptions = {}) {
    this.transport = transport;
    this.interRequestDelayMs = Math.max(0, options.interRequestDelayMs ?? 10);
    this.handleMessage = this.handleMessage.bind(this);
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.transport.on("message", this.handleMessage);
    this.initialized = true;
  }
  /**
 * Creates a command packet with a unique identifier.
 * @param payload - The request payload containing the command data and parameters
 * @param packetId - A unique identifier assigned to this packet for tracking and response correlation
 * @returns {Command & RequestPayload} A packet object combining command metadata with request payload data, including the assigned packet ID
 */
  public request(payload: RequestPayload, timeoutMs = 500): Promise<unknown> {
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

  /**
   * Send an actuator-style command using the existing request queue.
   * Accepts any `Command`-shaped payload; useful for higher-level helpers.
   */
  public sendActuatorCommand(
    payload: RequestPayload,
    timeoutMs = 2000
  ): Promise<unknown> {
    return this.request(payload, timeoutMs);
  }

  /**
   * Send a command without waiting for a reply. This will not occupy the
   * request queue but will still respect inter-request spacing and is
   * serialized with other direct sends to avoid DE/RE races.
   */
  public async sendNoReply(payload: RequestPayload): Promise<void> {
    // append to lock chain
    const doSend = async () => {
      const now = Date.now();
      if (now < this.nextAvailableAt) {
        await new Promise((r) => setTimeout(r, this.nextAvailableAt - now));
      }

      const packetId = payload.id ?? this.nextRequestId();
      const packet: RequestPayload & { id: string } = { ...payload, id: packetId } as any;

      try {
        await this.transport.sendCommand(packet);
      } finally {
        this.nextAvailableAt = Date.now() + this.interRequestDelayMs;
      }
    };

    // chain onto the lock so concurrent direct sends are serialized
    this.directSendLock = this.directSendLock.then(() => doSend());
    // return a promise that resolves when this send completes
    return this.directSendLock;
  }

  /**
   * Convenience helper for sending a PWM command to a node.
   */
  public sendPWM(
    node: string | undefined,
    pin: number | string,
    duty: number,
    frequency?: number,
    durationMs?: number,
    timeoutMs = 0
  ): Promise<unknown> {
    const packet: RequestPayload = {
      cmd: "pwm",
      node,
      payload: {
        pin,
        duty,
        frequency,
        durationMs,
      },
    } as RequestPayload;

    // If caller requested a no-timeout send, use the non-blocking path so the
    // queued request pipeline is not held waiting for a reply.
    if (!timeoutMs || timeoutMs <= 0) {
      return this.sendNoReply(packet).then(() => undefined);
    }

    return this.request(packet, timeoutMs);
  }

  private processQueue(): void {
    if (this.current) return;
    if (this.queueTimer) return;

    const now = Date.now();
    if (now < this.nextAvailableAt) {
      this.queueTimer = setTimeout(() => {
        this.queueTimer = undefined;
        this.processQueue();
      }, this.nextAvailableAt - now);
      return;
    }

    const next = this.queue.shift();
    if (!next) return;

    this.current = next;
    next.timer = setTimeout(() => this.handleTimeout(), next.timeoutMs);

    try {
      const sendPromise = this.transport.sendCommand(next.payload);
      sendPromise.catch((err) => this.resolveCurrent(err, undefined));
    } catch (err) {
      this.resolveCurrent(err, undefined);
    }
  }

  private handleMessage(message: unknown) {
    if (!this.current || !message || typeof message !== "object") return;
    const msg = message as Record<string, unknown>;
    const replyTo = this.normalizeId(
      msg.replyTo ?? msg.id ?? msg.reply_to ?? msg.responseTo
    );
    if (!replyTo) return;

    const expected = this.normalizeId(this.current.id);
    if (replyTo !== expected) {
      console.warn(
        `[Bus] Received reply for id=${replyTo}, expected ${expected}`
      );
      return;
    }
    this.resolveCurrent(undefined, message);
  }

  private normalizeId(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    if (!str) return null;
    // allow numeric replyTo values to match zero-padded request ids
    const normalized = str.replace(/^0+(?=\d)/, "");
    return normalized.length > 0 ? normalized : "0";
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
    this.nextAvailableAt = Date.now() + this.interRequestDelayMs;

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

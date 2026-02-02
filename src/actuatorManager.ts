import net from "node:net";

type PendingDispatch = {
  sockets: Set<net.Socket>;
  timer?: NodeJS.Timeout;
  expectedPin?: number | string | null;
  createdAt: number;
};

type ActuatorEntry = {
  node?: string;
  pin?: number | string;
  running: boolean;
  duty?: number;
  updatedAt: number;
};

const pendingDispatchResponses = new Map<string, PendingDispatch>();
const actuatorState = new Map<string, ActuatorEntry>();

let broadcaster: ((payload: string) => void) | null = null;
export function setBroadcaster(fn: (payload: string) => void) {
  broadcaster = fn;
}

let persistFn: ((entry: { node?: string; pin?: string | number; running: boolean; duty?: number; updatedAt?: number }) => void) | null = null;
export function setPersistFn(fn: (entry: { node?: string; pin?: string | number; running: boolean; duty?: number; updatedAt?: number }) => void) {
  persistFn = fn;
}

const actuatorKey = (node?: string | null, pin?: number | string | null) => {
  const n = node ? String(node) : "";
  const p = pin !== undefined && pin !== null ? String(pin) : "";
  return `${n}#${p}`;
};

export function registerDispatch(idRaw: string, socket: net.Socket, expectedPin?: number | string | null, ttlMs = 60000) {
  const id = String(idRaw ?? "").replace(/^0+(?=\d)/, "");
  const existing = pendingDispatchResponses.get(id);
  if (existing) {
    existing.sockets.add(socket);
    return;
  }

  const entry: PendingDispatch = {
    sockets: new Set([socket]),
    createdAt: Date.now(),
    expectedPin: expectedPin ?? null,
  };
  entry.timer = setTimeout(() => pendingDispatchResponses.delete(id), ttlMs);
  pendingDispatchResponses.set(id, entry);
}

export function clearDispatch(idRaw: string) {
  const id = String(idRaw ?? "").replace(/^0+(?=\d)/, "");
  const existing = pendingDispatchResponses.get(id);
  if (!existing) return;
  if (existing.timer) clearTimeout(existing.timer);
  pendingDispatchResponses.delete(id);
}

function setActuator(node?: string, pin?: number | string, running = false, duty?: number) {
  const key = actuatorKey(node, pin as any);
  const entry: ActuatorEntry = { node, pin, running, duty, updatedAt: Date.now() };
  actuatorState.set(key, entry);
  if (broadcaster) {
    try {
      const payload = JSON.stringify({ event: "actuator_state", data: entry }) + "\n";
      broadcaster(payload);
    } catch (e) {
      // ignore broadcast errors
    }
  }
  if (persistFn) {
    try {
      persistFn({ node: entry.node, pin: entry.pin, running: entry.running, duty: entry.duty, updatedAt: entry.updatedAt });
    } catch (e) {}
  }
  return entry;
}

export function importActuatorState(entry: ActuatorEntry) {
  const key = actuatorKey(entry.node, entry.pin as any);
  actuatorState.set(key, entry);
  if (broadcaster) {
    try {
      const payload = JSON.stringify({ event: "actuator_state", data: entry }) + "\n";
      broadcaster(payload);
    } catch (e) {}
  }
}

export function getActuatorState(node?: string, pin?: number | string) {
  if (node !== undefined || pin !== undefined) {
    const key = actuatorKey(node as any, pin as any);
    return actuatorState.get(key) ?? null;
  }
  return Array.from(actuatorState.values());
}

export function handleNodeMessage(msg: Record<string, unknown>) {
  // handle replies that refer to a previously dispatched id
  const replyTo = (msg.replyTo ?? msg.id ?? msg.reply_to ?? msg.responseTo) as string | undefined;
  if (replyTo) {
    const normalized = String(replyTo).replace(/^0+(?=\d)/, "");
    const pending = pendingDispatchResponses.get(normalized);
    if (pending) {
      // forward reply to all sockets that dispatched
      for (const s of pending.sockets) {
        try {
          if (s && !s.destroyed && s.writable) {
            s.write(JSON.stringify({ event: "rs485_reply", data: msg }) + "\n");
          }
        } catch (e) {
          // ignore socket write errors
        }
      }

      // update actuatorState if reply contains actuator info
      if (msg.actuator && typeof msg.actuator === "object") {
        try {
          const act = msg.actuator as Record<string, unknown>;
          const pin = act.pin as number | string | undefined;
          const duty = act.duty as number | undefined;
          const node = (msg as any).node as string | undefined;
          setActuator(node, pin, !!duty && duty > 0, duty);
        } catch (e) {
          // ignore malformed actuator object
        }
      }

      if (pending.timer) clearTimeout(pending.timer);
      pendingDispatchResponses.delete(normalized);
      return;
    }
  }

  // handle actuator_state events
  if (msg.event === "actuator_state" && msg.data) {
    try {
      const data = msg.data as Record<string, unknown>;
      const pin = data.pin as number | string | undefined;
      const running = data.running as boolean | undefined;
      const duty = data.duty as number | undefined;
      const node = (msg as any).node as string | undefined;
      if (pin !== undefined) {
        setActuator(node, pin, !!running, duty);
        // forward to any pending dispatches waiting for this pin
        for (const [id, pending] of pendingDispatchResponses.entries()) {
          if (pending.expectedPin != null && String(pending.expectedPin) === String(pin)) {
            for (const s of pending.sockets) {
              try {
                if (s && !s.destroyed && s.writable) {
                  s.write(JSON.stringify({ event: "actuator_state", id, data }) + "\n");
                }
              } catch (e) {}
            }
            if (pending.timer) clearTimeout(pending.timer);
            pendingDispatchResponses.delete(id);
          }
        }
      }
    } catch (e) {
      // ignore malformed event
    }
  }
}

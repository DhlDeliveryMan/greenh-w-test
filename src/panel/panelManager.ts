import { EventEmitter } from "events";
import { MCP23017Driver } from "./drivers/mcp23017";
import { MCP3208Driver } from "./drivers/mcp3208";
import { Mux4052Driver } from "./drivers/mux4052";
import { AnalogControlConfig, DigitalControlConfig, PanelConfig } from "./config";

export type PanelState = {
    digital: Record<string, boolean>;
    analog: Record<string, number>;
    timestamp: number;
};

export class PanelManager extends EventEmitter {
    private readonly mcpMap = new Map<string, MCP23017Driver>();
    private readonly adc: MCP3208Driver;
    private readonly mux?: Mux4052Driver;
    private readonly digitalCfg: DigitalControlConfig[];
    private readonly analogCfg: AnalogControlConfig[];
    private pollTimer?: NodeJS.Timeout;
    private state: PanelState = { digital: {}, analog: {}, timestamp: Date.now() };

    constructor(cfg: PanelConfig) {
        super();
        for (const chip of cfg.mcpChips) {
            this.mcpMap.set(chip.id, new MCP23017Driver({ address: chip.address, device: chip.device, inputPins: chip.inputPins, outputPins: chip.outputPins }));
        }
        this.adc = new MCP3208Driver(cfg.adc);
        this.mux = cfg.mux.enabled ? new Mux4052Driver(cfg.mux.options) : undefined;
        this.digitalCfg = cfg.digitalControls;
        this.analogCfg = cfg.analogControls;
    }

    async init(): Promise<void> {
        for (const [id, drv] of this.mcpMap.entries()) {
            console.log(`[panel] Initializing ${id}...`);
            await drv.init();
            console.log(`[panel] ${id} initialized`);
        }
        // Poll once to establish initial state
        await this.poll();
        console.log(`[panel] Initial state:`, JSON.stringify(this.state));
    }

    start(pollMs = 100): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => {
            this.poll().catch((err) => console.error("Panel poll failed", err));
        }, pollMs);
    }

    stop(): void {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = undefined;
    }

    getState(): PanelState {
        return this.state;
    }

    getMCP(id: "mcp23017-0x20" | "mcp23017-0x21"): MCP23017Driver | undefined {
        return this.mcpMap.get(id);
    }

    private async poll(): Promise<void> {
        const nextState: PanelState = { digital: { ...this.state.digital }, analog: { ...this.state.analog }, timestamp: Date.now() };
        let changed = false;
        const changes: { digital: Record<string, boolean>; analog: Record<string, number> } = { digital: {}, analog: {} };

        // Digital inputs
        for (const d of this.digitalCfg) {
            const drv = this.mcpMap.get(d.chip);
            if (!drv) {
                console.warn(`[panel] Chip ${d.chip} not found for ${d.id}`);
                continue;
            }
            try {
                const val = await drv.readPin(d.pin);
                if (nextState.digital[d.id] !== val) {
                    nextState.digital[d.id] = val;
                    changed = true;
                    changes.digital[d.id] = val;
                }
            } catch (err) {
                console.error(`[panel] Digital read failed for ${d.id} (${d.chip} pin ${d.pin}):`, err);
            }
        }

        // Analog inputs
        for (const a of this.analogCfg) {
            try {
                if (this.mux && a.muxChannel !== undefined) {
                    this.mux.setChannel(a.muxChannel);
                    await new Promise((r) => setTimeout(r, 1)); // settle
                }
                const reading = await this.adc.readChannel(a.channel);
                const prev = nextState.analog[a.id] ?? 0;
                const alpha = a.smoothing ?? 0.2;
                const rawVal = reading.value; // 0..1
                const smoothed = alpha * rawVal + (1 - alpha) * prev;
                const deadband = a.deadband ?? 0.01;
                const diff = Math.abs(smoothed - (this.state.analog[a.id] ?? 0));

                // Debug: log every read (comment out once working)
                if (Math.random() < 0.01) { // 1% sample rate to avoid spam
                    console.log(`[panel] ${a.id} raw=${rawVal.toFixed(3)} smoothed=${smoothed.toFixed(3)} prev=${(this.state.analog[a.id] ?? 0).toFixed(3)} diff=${diff.toFixed(4)} deadband=${deadband}`);
                }

                if (diff > deadband) {
                    nextState.analog[a.id] = smoothed;
                    changed = true;
                    changes.analog[a.id] = smoothed;
                }
            } catch (err) {
                console.error(`[panel] Analog read failed for ${a.id}`, err);
            }
        }

        if (changed) {
            this.state = nextState;
            console.log(`[panel] CHANGE:`, JSON.stringify(changes));
            this.emit("panel_state", this.state);
        }
    }
}

import { EventEmitter } from "events";
import { LCD1602Driver } from "./drivers/lcd1602";
import { TM1637Driver } from "./drivers/tm1637";
import { MCP23017Driver } from "./drivers/mcp23017";

export interface DisplayConfig {
    lcd1602?: {
        address?: number;
        device?: number;
        id?: string;
    };
    lcd1602s?: Array<{
        address?: number;
        device?: number;
        id: string;
    }>;
    tm1637?: {
        mcpChip: MCP23017Driver;
        clkPin: number;
        dioPin: number;
        brightness?: number;
        digits?: number;
        digitOrder?: number[];
        id?: string;
    };
}

export class DisplayManager extends EventEmitter {
    private readonly lcds = new Map<string, LCD1602Driver>();
    private tm1637?: TM1637Driver;
    private defaultId?: string;

    constructor(cfg: DisplayConfig = {}) {
        super();
        if (cfg.lcd1602) {
            const id = cfg.lcd1602.id ?? "lcd1";
            this.lcds.set(id, new LCD1602Driver(cfg.lcd1602));
            this.defaultId = id;
        }
        if (cfg.lcd1602s?.length) {
            for (const lcd of cfg.lcd1602s) {
                this.lcds.set(lcd.id, new LCD1602Driver(lcd));
                if (!this.defaultId) this.defaultId = lcd.id;
            }
        }
        if (cfg.tm1637) {
            this.tm1637 = new TM1637Driver(cfg.tm1637.mcpChip, {
                clkPin: cfg.tm1637.clkPin,
                dioPin: cfg.tm1637.dioPin,
                brightness: cfg.tm1637.brightness,
                digits: cfg.tm1637.digits,
                digitOrder: cfg.tm1637.digitOrder,
            });
        }
    }

    async init(): Promise<void> {
        for (const [id, lcd] of this.lcds.entries()) {
            await lcd.init();
            await lcd.clear();
            await lcd.print(`Greenhouse v2`);
            console.log(`[display] LCD1602 ${id} initialized`);
        }
        if (this.tm1637) {
            await this.tm1637.init();
            // await this.tm1637.clear();
            await this.delay(100);
            // Test display
            await this.tm1637.displayText("HELL!");
            console.log(`[display] TM1637 initialized and tested`);
        }
        if (this.lcds.size || this.tm1637) {
            console.log("[display] DisplayManager initialized");
        }
    }

    getTM1637(): TM1637Driver | undefined {
        return this.tm1637;
    }

    private async delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    getLCD(id?: string): LCD1602Driver | undefined {
        if (id) return this.lcds.get(id);
        if (this.defaultId) return this.lcds.get(this.defaultId);
        return undefined;
    }

    async clear(id?: string): Promise<void> {
        if (id) {
            const lcd = this.lcds.get(id);
            if (lcd) await lcd.clear();
            return;
        }
        for (const lcd of this.lcds.values()) {
            await lcd.clear();
        }
    }

    async writeLine(row: number, text: string, id?: string): Promise<void> {
        if (id) {
            const lcd = this.lcds.get(id);
            if (lcd) await lcd.writeLine(row, text);
            return;
        }
        for (const lcd of this.lcds.values()) {
            await lcd.writeLine(row, text);
        }
    }

    async write(row: number, col: number, text: string, id?: string): Promise<void> {
        if (id) {
            const lcd = this.lcds.get(id);
            if (lcd) await lcd.write(row, col, text);
            return;
        }
        for (const lcd of this.lcds.values()) {
            await lcd.write(row, col, text);
        }
    }
}

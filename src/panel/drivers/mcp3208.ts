import mcpadc = require("mcp-spi-adc");

export interface MCP3208Options {
    speedHz?: number;
    device?: number; // chip select 0 or 1
}

export type MCP3208Reading = { raw: number; value: number };

export class MCP3208Driver {
    private readonly channels = new Map<number, any>();
    private readonly speedHz: number;
    private readonly device: number;

    constructor(opts: MCP3208Options = {}) {
        this.speedHz = opts.speedHz ?? 135000;
        this.device = opts.device ?? 0; // CE0 by default
    }

    private async openChannel(channel: number): Promise<any> {
        if (this.channels.has(channel)) return this.channels.get(channel);
        return new Promise((resolve, reject) => {
            const ch = mcpadc.open(channel, { speedHz: this.speedHz, device: this.device }, (err: Error | null) => {
                if (err) {
                    console.error(`MCP3208 open ch${channel} failed`, err);
                    return reject(err);
                }
                this.channels.set(channel, ch);
                resolve(ch);
            });
        });
    }

    async readChannel(channel: number): Promise<MCP3208Reading> {
        const ch = await this.openChannel(channel);
        return new Promise((resolve, reject) => {
            ch.read((err: Error | null, reading: { rawValue: number; value: number }) => {
                if (err) return reject(err);
                resolve({ raw: reading.rawValue, value: reading.value });
            });
        });
    }

    closeAll(): void {
        for (const ch of this.channels.values()) {
            try {
                ch.close(() => { });
            } catch (e) {
                // ignore
            }
        }
        this.channels.clear();
    }
}

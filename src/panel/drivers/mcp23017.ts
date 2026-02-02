import MCP23017 = require("node-mcp23017");

export type PinDirection = "in" | "out";

export interface MCP23017Options {
    address: number;
    device?: number; // I2C bus (default 1)
    inputPins?: number[];
    outputPins?: number[];
}

export class MCP23017Driver {
    private readonly chip: any;
    private readonly inputPins: Set<number>;
    private readonly outputPins: Set<number>;
    private pullupConfigured = false;

    constructor(opts: MCP23017Options) {
        this.chip = new MCP23017({ address: opts.address, device: opts.device ?? 1 });
        this.inputPins = new Set(opts.inputPins ?? []);
        this.outputPins = new Set(opts.outputPins ?? []);
    }

    async init(): Promise<void> {
        // Configure pin directions
        for (const pin of this.inputPins) {
            if (this.chip.INPUT_PULLUP !== undefined) {
                this.chip.pinMode(pin, this.chip.INPUT_PULLUP);
            } else {
                this.chip.pinMode(pin, this.chip.INPUT);
            }
        }
        for (const pin of this.outputPins) {
            this.chip.pinMode(pin, this.chip.OUTPUT);
        }

        // Enable internal pull-ups on all inputs (switches to GND)
        if (this.chip.INPUT_PULLUP === undefined) {
            await this.enableInputPullups();
        }
    }

    async readPin(pin: number): Promise<boolean> {
        return new Promise((resolve, reject) => {
            this.chip.digitalRead(pin, (_pin: number, err: Error | null, value: number | undefined) => {
                if (err) return reject(err);
                resolve(!!value);
            });
        });
    }

    async writePin(pin: number, value: boolean): Promise<void> {
        if (!this.outputPins.has(pin)) throw new Error(`Pin ${pin} not configured as output`);

        // Try synchronous write first (library may not support async)
        try {
            this.chip.digitalWrite(pin, value ? 1 : 0);
            return Promise.resolve();
        } catch (err) {
            // If sync fails, try async with callback
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`MCP23017 writePin timeout (pin ${pin})`));
                }, 1000);

                try {
                    this.chip.digitalWrite(pin, value ? 1 : 0, (err: Error | null) => {
                        clearTimeout(timeout);
                        if (err) return reject(err);
                        resolve();
                    });
                } catch (err) {
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        }
    }

    async setPinMode(pin: number, mode: "input" | "output", pullup = true): Promise<void> {
        let modeConst: number;
        if (mode === "input") {
            modeConst = (pullup && this.chip.INPUT_PULLUP !== undefined) ? this.chip.INPUT_PULLUP : this.chip.INPUT;
        } else {
            modeConst = this.chip.OUTPUT;
        }
        this.chip.pinMode(pin, modeConst);

        if (mode === "input") {
            this.inputPins.add(pin);
            this.outputPins.delete(pin);
        } else {
            this.outputPins.add(pin);
            this.inputPins.delete(pin);
        }
    }

    private async enableInputPullups(): Promise<void> {
        if (this.pullupConfigured) return;
        const pullupFn: ((pin: number, value: number, cb?: (err?: Error | null) => void) => unknown) | undefined =
            typeof this.chip.pullUp === "function"
                ? this.chip.pullUp.bind(this.chip)
                : typeof this.chip.pullup === "function"
                    ? this.chip.pullup.bind(this.chip)
                    : typeof this.chip.setPullup === "function"
                        ? this.chip.setPullup.bind(this.chip)
                        : undefined;

        if (!pullupFn) {
            console.warn("MCP23017 driver does not support pull-up configuration; inputs may float");
            this.pullupConfigured = true;
            return;
        }

        for (const pin of this.inputPins) {
            await new Promise<void>((resolve, reject) => {
                const done = (err?: Error | null) => (err ? reject(err) : resolve());
                try {
                    if (pullupFn.length >= 3) {
                        pullupFn(pin, 1, done);
                    } else {
                        const res = pullupFn(pin, 1);
                        if (res && typeof (res as Promise<void>).then === "function") {
                            (res as Promise<void>).then(() => done()).catch(done);
                        } else {
                            done();
                        }
                    }
                } catch (err) {
                    done(err as Error);
                }
            });
        }

        this.pullupConfigured = true;
    }
}

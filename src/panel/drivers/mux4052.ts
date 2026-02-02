import onoff = require("onoff");
const { Gpio } = onoff;

export interface Mux4052Options {
    s0: number;
    s1: number;
    enablePin?: number;
}

export class Mux4052Driver {
    private readonly s0: any;
    private readonly s1: any;
    private readonly en?: any;

    constructor(opts: Mux4052Options) {
        this.s0 = new Gpio(opts.s0, "out");
        this.s1 = new Gpio(opts.s1, "out");
        this.en = opts.enablePin !== undefined ? new Gpio(opts.enablePin, "out") : undefined;
    }

    setChannel(channel: number): void {
        const c = channel & 0x03;
        this.s0.writeSync(c & 0x01);
        this.s1.writeSync((c >> 1) & 0x01);
        if (this.en) this.en.writeSync(0); // active low enable if wired, adjust as needed
    }

    disable(): void {
        if (this.en) this.en.writeSync(1);
    }

    cleanup(): void {
        try {
            this.s0.unexport();
            this.s1.unexport();
            if (this.en) this.en.unexport();
        } catch (e) {
            // ignore
        }
    }
}

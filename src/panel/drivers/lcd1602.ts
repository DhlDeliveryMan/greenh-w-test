const LCD = require("raspberrypi-liquid-crystal");

export interface LCD1602Options {
    address?: number; // I2C address, default 0x27
    device?: number; // I2C bus, default 1
    columns?: number; // default 16
    rows?: number; // default 2
}

export class LCD1602Driver {
    private readonly lcd: any;
    private readonly cols: number;
    private readonly rows: number;

    constructor(opts: LCD1602Options = {}) {
        const bus = opts.device ?? 1;
        const address = opts.address ?? 0x27;
        this.cols = opts.columns ?? 16;
        this.rows = opts.rows ?? 2;

        // Constructor: (bus, address, columns, rows)
        this.lcd = new LCD(bus, address, this.cols, this.rows);
    }

    async init(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.lcd.beginSync();
                console.log(`[lcd] LCD1602 initialized`);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    async clear(): Promise<void> {
        return new Promise((resolve) => {
            this.lcd.clearSync();
            resolve();
        });
    }

    async home(): Promise<void> {
        return new Promise((resolve) => {
            this.lcd.homeSync();
            resolve();
        });
    }

    async setCursor(col: number, row: number): Promise<void> {
        return new Promise((resolve) => {
            this.lcd.setCursorSync(col, row);
            resolve();
        });
    }

    async print(text: string): Promise<void> {
        return new Promise((resolve) => {
            this.lcd.printSync(text);
            resolve();
        });
    }

    async writeLine(row: number, text: string): Promise<void> {
        await this.setCursor(0, row);
        // Pad or truncate to column width
        const padded = (text + " ".repeat(this.cols)).substring(0, this.cols);
        await this.print(padded);
    }

    async write(row: number, col: number, text: string): Promise<void> {
        await this.setCursor(col, row);
        await this.print(text);
    }
}

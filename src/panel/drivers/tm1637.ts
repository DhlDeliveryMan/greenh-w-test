import { MCP23017Driver } from "./mcp23017";

const CMD_DATA_AUTO = 0x40;
const CMD_DATA_FIXED = 0x44;
const CMD_ADDRESS = 0xc0;
const CMD_DISPLAY_ON = 0x88;

export interface TM1637Options {
    clkPin: number;
    dioPin: number;
    brightness?: number; // 0-7
    digits?: number; // number of digits on the module
    digitOrder?: number[]; // logical index -> physical position mapping
}

export class TM1637Driver {
    private readonly mcp: MCP23017Driver;
    private readonly clkPin: number;
    private readonly dioPin: number;
    private brightness: number;
    private digits: number;
    private digitOrder?: number[];

    constructor(mcp: MCP23017Driver, opts: TM1637Options) {
        this.mcp = mcp;
        this.clkPin = opts.clkPin;
        this.dioPin = opts.dioPin;
        this.brightness = opts.brightness ?? 2;
        this.digits = Math.max(1, Math.min(8, opts.digits ?? 4));
        this.digitOrder = opts.digitOrder && opts.digitOrder.length ? opts.digitOrder : undefined;
    }

    async init(): Promise<void> {
        console.log(`[tm1637] Initializing on MCP23017 pins ${this.clkPin}/${this.dioPin}`);
        // Ensure pins are outputs
        await this.mcp.setPinMode(this.clkPin, "output");
        await this.mcp.setPinMode(this.dioPin, "output");

        // Idle state: Both High
        await this.mcp.writePin(this.clkPin, true);
        await this.mcp.writePin(this.dioPin, true);
        await this.setBrightness(this.brightness);
    }

    private async bitDelay(): Promise<void> {
        // Add explicit delay for slow I2C GPIO operations
        return this.delay(8);
    }

    private async delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async start(): Promise<void> {
        await this.mcp.writePin(this.clkPin, true);
        await this.mcp.writePin(this.dioPin, true);
        await this.bitDelay();
        await this.mcp.writePin(this.dioPin, false);
        await this.bitDelay();
        await this.mcp.writePin(this.clkPin, false);
    }

    private async stop(): Promise<void> {
        await this.mcp.writePin(this.clkPin, false);
        await this.mcp.writePin(this.dioPin, false);
        await this.bitDelay();
        await this.mcp.writePin(this.clkPin, true);
        await this.bitDelay();
        await this.mcp.writePin(this.dioPin, true);
    }

    private async writeByte(byte: number): Promise<void> {
        // Write 8 bits (LSB first)
        for (let i = 0; i < 8; i++) {
            await this.mcp.writePin(this.clkPin, false);
            await this.mcp.writePin(this.dioPin, !!(byte & (1 << i)));
            await this.bitDelay();
            await this.mcp.writePin(this.clkPin, true);
            await this.bitDelay();
        }

        // --- ACK Cycle ---
        await this.mcp.writePin(this.clkPin, false);
        await this.delay(10); // Extra delay before mode switch

        // Switch to input WITHOUT pullup - TM1637 has internal pullup, will pull LOW for ACK
        await this.mcp.setPinMode(this.dioPin, "input", false);
        await this.delay(30); // Extended delay for TM1637 to respond through slow I2C

        await this.mcp.writePin(this.clkPin, true);

        let ack = false;
        let lastDio = true;
        // Poll DIO while CLK is high to catch a late ACK
        for (let i = 0; i < 6; i++) {
            await this.delay(10);
            lastDio = await this.mcp.readPin(this.dioPin);
            if (!lastDio) {
                ack = true;
                break;
            }
        }

        console.log(`[tm1637] Byte 0x${byte.toString(16).padStart(2, '0')} ACK=${ack ? 'OK' : 'FAIL'} (DIO=${lastDio})`);

        if (ack) {
            // If ack is true (High), it means the display didn't pull it Low.
            // This usually means a wiring issue or wrong pins.
            // console.warn("[tm1637] No ACK!");
        }

        await this.mcp.writePin(this.clkPin, false);
        await this.bitDelay();

        // Switch back to output, set HIGH by default
        await this.mcp.setPinMode(this.dioPin, "output");
        await this.mcp.writePin(this.dioPin, true);
        await this.delay(5); // Extended settling time
    }

    async setBrightness(level: number): Promise<void> {
        this.brightness = Math.max(0, Math.min(7, level));
        await this.start();
        await this.writeByte(CMD_DISPLAY_ON | this.brightness);
        await this.stop();
    }

    async displayRaw(segments: number[]): Promise<void> {
        // 1. Send Data Command (fixed address mode for reliability)
        await this.start();
        await this.writeByte(CMD_DATA_FIXED);
        await this.stop();

        // 2. Send Address and Data per digit
        const mappedSegments = new Array(this.digits).fill(0x00);
        if (this.digitOrder && this.digitOrder.length >= this.digits) {
            for (let i = 0; i < this.digits; i++) {
                const physicalIndex = this.digitOrder[i];
                if (physicalIndex >= 0 && physicalIndex < this.digits) {
                    mappedSegments[physicalIndex] = segments[i] ?? 0x00;
                }
            }
        } else {
            for (let i = 0; i < this.digits; i++) mappedSegments[i] = segments[i] ?? 0x00;
        }

        for (let i = 0; i < this.digits; i++) {
            await this.start();
            await this.writeByte(CMD_ADDRESS + i);
            await this.writeByte(mappedSegments[i] ?? 0x00);
            await this.stop();
        }

        // 3. Display Control (Brightness/ON)
        await this.start();
        await this.writeByte(CMD_DISPLAY_ON | this.brightness);
        await this.stop();
    }

    async displayNumber(num: number): Promise<void> {
        const digits = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
        const val = Math.floor(Math.abs(num)).toString().padStart(this.digits, ' ');
        const segments = val.split('').map(char => char === ' ' ? 0x00 : digits[parseInt(char)]);
        await this.displayRaw(segments);
    }

    async displayText(text: string): Promise<void> {
        const charMap: Record<string, number> = {
            'A': 0x77, 'B': 0x7c, 'C': 0x39, 'D': 0x5e, 'E': 0x79, 'F': 0x71,
            'H': 0x76, 'I': 0x06, 'L': 0x38, 'O': 0x3f, 'P': 0x73, 'U': 0x3e,
            ' ': 0x00, '-': 0x40, '!': 0x80
        };
        // Add 0-9 to charMap
        for (let i = 0; i < 10; i++) charMap[i.toString()] = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f][i];

        const segments = text.padEnd(this.digits, ' ').substring(0, this.digits).split('')
            .map(c => charMap[c.toUpperCase()] ?? 0x00);
        await this.displayRaw(segments);
    }

    async displayAllOn(): Promise<void> {
        const segments = Array.from({ length: this.digits }, () => 0x7f);
        await this.displayRaw(segments);
    }
}
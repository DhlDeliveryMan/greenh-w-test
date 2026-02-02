# Greenhouse Worker

Node/TypeScript worker service for a Raspberry Pi greenhouse controller. It manages RS485 comms, sensor polling, panel I/O (digital + analog), and display devices (LCD1602 + TM1637).

## Features
- RS485 command/telemetry bridge with heartbeat monitoring
- Sensor polling with persistence to SQLite
- Panel manager with MCP23017 GPIO expanders and MCP3208 ADC
- Analog mux support (74HC4052)
- LCD1602 display support (I2C)
- TM1637 7‑segment display support (via MCP23017)

## Hardware
- Raspberry Pi (I2C + SPI enabled)
- MCP23017 I2C GPIO expanders @ 0x20 and 0x21
- MCP3208 ADC (SPI CE0)
- 74HC4052 analog mux
- LCD1602 I2C modules @ 0x27 and 0x23
- TM1637 6‑digit display (two 3‑digit groups)

## Pin/Bus Map (current config)
**MCP23017**
- 0x20: GPB2‑5 inputs (pins 10–13)
- 0x21: GPA0‑7 + GPB0‑5 inputs (pins 0–13)
- 0x21: GPB6/GPB7 outputs (pins 14/15) used for TM1637

**TM1637 (via MCP23017 0x21)**
- CLK: GPB6 (pin 14)
- DIO: GPB7 (pin 15)
- Uses a level shifter if the module is 5V
- Digit order remapped for this module

**Analog**
- MCP3208 on SPI bus (device 0)
- 74HC4052 mux select: GPIO26 (S0), GPIO19 (S1)

**LCD1602**
- I2C @ 0x27 and 0x23 on bus 1

## Setup
1. Enable I2C + SPI on the Pi
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build (optional for production):
   ```bash
   npm run build
   ```

## Run
Development:
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

## Environment Variables
- `RS485_PORT`: Serial device path (ex: /dev/ttyUSB0)
- `RS485_BAUD`: Override baud rate
- `RS485_DEBUG`: Set to 1 for traffic logging
- `RS485_HEARTBEAT_TIMEOUT_MS`: Heartbeat timeout
- `RS485_DRIVER_PIN` / `RS485_DE_PIN`: Override RS485 DE pin
- `RS485_RECEIVER_PIN` / `RS485_RE_PIN`: Override RS485 RE pin
- `RS485_RE_ACTIVE_LOW`: Set to 0 to disable active-low RE

## Notes
- Panel switches are wired to GND and use input pull‑ups.
- The TM1637 uses a custom timing/ACK sequence due to GPIO expander latency.
- Edit panel wiring and controls in `src/panel/config.ts`.

## License
Apache-2.0
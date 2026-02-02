import { Mux4052Options } from "./drivers/mux4052";

export type DigitalControlType = "button" | "switch" | "encoder";
export type AnalogControlType = "knob" | "slider" | "sensor";

export interface DigitalControlConfig {
    id: string;
    chip: "mcp23017-0x20" | "mcp23017-0x21";
    pin: number; // 0-15
    type: DigitalControlType;
    debounceMs?: number;
}

export interface AnalogControlConfig {
    id: string;
    channel: number; // MCP3208 channel 0-7
    muxChannel?: number; // 0-3 if routed through 4052
    type: AnalogControlType;
    smoothing?: number; // 0..1 EMA alpha
    deadband?: number; // 0..1 fraction
}

export interface PanelConfig {
    mcpChips: Array<{ id: "mcp23017-0x20" | "mcp23017-0x21"; address: number; device?: number; inputPins: number[]; outputPins: number[] }>;
    mux: { enabled: boolean; options: Mux4052Options };
    adc: { device?: number; speedHz?: number };
    digitalControls: DigitalControlConfig[];
    analogControls: AnalogControlConfig[];
    gpoIndicators?: Array<{ chip: "mcp23017-0x21" | "mcp23017-0x20"; pin: number; id: string }>;
}

export const panelConfig: PanelConfig = {
    mcpChips: [
        { id: "mcp23017-0x20", address: 0x20, device: 1, inputPins: [10, 11, 12, 13], outputPins: [] },
        { id: "mcp23017-0x21", address: 0x21, device: 1, inputPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], outputPins: [14, 15] }, // GPB6(14)=CLK, GPB7(15)=DIO for TM1637
    ],
    mux: { enabled: true, options: { s0: 26, s1: 19 } },
    adc: { device: 0, speedHz: 135000 },
    digitalControls: [
        // 0x21 GPA0-7
        { id: "mcp21_gpa0", chip: "mcp23017-0x21", pin: 0, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpa1", chip: "mcp23017-0x21", pin: 1, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpa2", chip: "mcp23017-0x21", pin: 2, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpa3", chip: "mcp23017-0x21", pin: 3, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpa4", chip: "mcp23017-0x21", pin: 4, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpa5", chip: "mcp23017-0x21", pin: 5, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpa6", chip: "mcp23017-0x21", pin: 6, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpa7", chip: "mcp23017-0x21", pin: 7, type: "switch", debounceMs: 15 },

        // 0x21 GPB0-7
        { id: "mcp21_gpb0", chip: "mcp23017-0x21", pin: 8, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpb1", chip: "mcp23017-0x21", pin: 9, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpb2", chip: "mcp23017-0x21", pin: 10, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpb3", chip: "mcp23017-0x21", pin: 11, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpb4", chip: "mcp23017-0x21", pin: 12, type: "switch", debounceMs: 15 },
        { id: "mcp21_gpb5", chip: "mcp23017-0x21", pin: 13, type: "switch", debounceMs: 15 },
        // GPB6 (pin 14) and GPB7 (pin 15) on 0x21 reserved for TM1637 CLK/DIO

        // 0x20 GPB2-7
        { id: "mcp20_gpb2", chip: "mcp23017-0x20", pin: 10, type: "switch", debounceMs: 15 },
        { id: "mcp20_gpb3", chip: "mcp23017-0x20", pin: 11, type: "switch", debounceMs: 15 },
        { id: "mcp20_gpb4", chip: "mcp23017-0x20", pin: 12, type: "switch", debounceMs: 15 },
        { id: "mcp20_gpb5", chip: "mcp23017-0x20", pin: 13, type: "switch", debounceMs: 15 },
        // GPB6 (pin 14) and GPB7 (pin 15) reserved for TM1637 CLK/DIO
    ],
    analogControls: [
        // { id: "adc_ch0", channel: 0, type: "knob", smoothing: 0.85, deadband: 0.01 },
        // { id: "adc_ch1", channel: 1, type: "knob", smoothing: 0.85, deadband: 0.01 },

        //           { id: "pot_mux0", channel: 7, muxChannel: 0, type: "knob", smoothing: 0.2, deadband: 0.01 },
        //   { id: "pot_mux1", channel: 7, muxChannel: 1, type: "knob", smoothing: 0.2, deadband: 0.01 },
        //   { id: "pot_mux2", channel: 7, muxChannel: 2, type: "knob", smoothing: 0.2, deadband: 0.01 },
        // { id: "pot_mux3", channel: 7, muxChannel: 0, type: "knob", smoothing: 0.2, deadband: 0.01 },

    ],
    gpoIndicators: [
        { chip: "mcp23017-0x21", pin: 15, id: "panel_led" },
    ],
};

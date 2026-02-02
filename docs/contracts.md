# RS485 Contracts and Node Registry (draft)

## Framing
- Transport: RS485, newline `"\n"` delimiter.
- Payloads: UTF-8 JSON.
- Requests: `{ cmd, id, node?, payload? }`
- Replies: `{ replyTo: <id>, ok: true|false, ... }` (allow `reply_to` alias from nodes).
- Events: `{ event, data }`
- Timeouts (client side):
  - `ping|who`: 1s
  - `sensor_read`: 2s
  - `actuator` (relay/pwm/light): 2s (use 0 for fire-and-forget)
  - `panel_state` push: none (event)

## Commands (master -> node)
- `ping`: reachability.
- `who`: identity.
- `sensor_read`: optional targeted read.
- `pwm`: `{ payload: { pin, duty, frequency?, durationMs? } }`
- `relay`: `{ payload: { channel|pin, on: boolean } }`
- `light_cct`: `{ payload: { warmPin, coolPin, dutyWarm, dutyCool } }` or `{ payload: { channel, duty, cct } }` depending on node implementation.
- `valve`: `{ payload: { channel|pin, on: boolean } }` (if driven by relays).
- `display_update`: `{ payload: { view: string, data: object } }` (panel/display node).
- `pump` (MOSFET/PWM-driven): `{ payload: { pin, duty?, on? } }` — duty 0..1 (or 0..100) for speed; if `on` provided, treat true→full, false→off.

## Replies (node -> master)
- Always include `replyTo` matching request id.
- On success: `{ replyTo, ok: true, ... }`
- On error: `{ replyTo, ok: false, error: "message" }`
- Actuator replies may include `actuator`: `{ pin, duty?, on?, running? }`

## Events (node -> master)
- `sensor_update`: `{ id, type, value, timestamp, node }`
- `actuator_state`: `{ pin, running, duty?, node }`
- `panel_state`: `{ modes, selectors, knobs, buttons, timestamp }`
- `warning`: `{ type, severity, message, timestamp, node }`

## Node registry (draft mapping)
- `esp32-main`: sensors (CO2, TVOC, SH, enclosure temp/hum, water temps), actuators (iritigation pump (pwm), greenhouse fans PWM), lights (CCT PWM, CW and WW pins.)
- `nano-tec`: sensors (TEC-related temps), actuators (TEC peltier drive, TEC fans, hot/cold pump as needed for TEC loop).
- `nano-display`:outputs (panel displays) over RS485. 

## Master-side expectations
- Master normalizes `replyTo` by stripping leading zeros.
- Master treats missing newline as blocking delivery; nodes must end replies/events with `\n`.
- Fire-and-forget commands use timeout 0; otherwise queue + timeout.

## To finalize with firmware authors
- Exact field names for actuator payloads per node (pin vs channel, cct vs warm/cool pins).
- Exact sensor ids/types emitted in `sensor_update`.
- Panel_state shape (switches/knobs/buttons names and ranges).
- Any node-specific min turnaround delays or baud changes.


GPIO 25: pump_irrigation
GPIO 26: fan_greenhouse
GPIO 32: light_cct_warm
GPIO 33: light_cct_cool
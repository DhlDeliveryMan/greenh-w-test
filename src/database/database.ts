import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import { SensorReading } from "../types";

export class DatabaseHandler {
  public database: Database.Database;
  private DATABASE_PATH: string;
  private upsertSensorStatement!: Database.Statement;
  private insertReadingStatement!: Database.Statement;
  private deleteOldReadingsStatement!: Database.Statement;

  private CREATE_SENSORS_TABLE = `
    CREATE TABLE IF NOT EXISTS sensors (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        location TEXT,
        description TEXT
    )
  `;

  private CREATE_SENSOR_READINGS_TABLE = `
    CREATE TABLE IF NOT EXISTS sensor_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        value REAL NOT NULL,
        FOREIGN KEY (sensor_id) REFERENCES sensors(id)
    )
  `;
  private CREATE_ACTUATORS_TABLE = `
    CREATE TABLE IF NOT EXISTS actuators (
        node TEXT,
        pin TEXT,
        running INTEGER NOT NULL,
        duty REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (node, pin)
    )
  `;

  private CREATE_SETPOINTS_TABLE = `
    CREATE TABLE IF NOT EXISTS setpoints (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  private setpointsCache = new Map<string, any>();

  constructor() {
    this.DATABASE_PATH = `${os.userInfo().homedir}/.ghw/data/greenhouse.db`;
    const dbExists = fs.existsSync(this.DATABASE_PATH);
    console.log(dbExists ? "Database found." : "Database not found, initializing...");
    console.log(`Using database at: ${this.DATABASE_PATH}`);

    if (!dbExists) {
      this.initializeDatabase();
    }

    this.database = new Database(this.DATABASE_PATH);
    this.database.pragma("journal_mode = WAL");

    this.createTables();
    this.prepareStatements();
    this.loadSetpoints();
  }

  private initializeDatabase() {
    console.log("Initializing database...");

    if (!fs.existsSync(`${os.userInfo().homedir}/.ghw/data`)) {
      fs.mkdirSync("/home/.ghw/data", { recursive: true });
    }

    fs.writeFileSync(this.DATABASE_PATH, "");
  }

  private createTables() {
    this.database.exec(this.CREATE_SENSORS_TABLE);
    this.database.exec(this.CREATE_SENSOR_READINGS_TABLE);
    this.database.exec(this.CREATE_ACTUATORS_TABLE);
    this.database.exec(this.CREATE_SETPOINTS_TABLE);
  }

  private prepareStatements() {
    this.upsertSensorStatement = this.database.prepare(`
      INSERT INTO sensors (id, type)
      VALUES (@id, @type)
      ON CONFLICT(id) DO UPDATE SET type = excluded.type
    `);

    this.insertReadingStatement = this.database.prepare(`
      INSERT INTO sensor_readings (sensor_id, timestamp, value)
      VALUES (@sensor_id, @timestamp, @value)
    `);

    this.deleteOldReadingsStatement = this.database.prepare(`
      DELETE FROM sensor_readings
      WHERE timestamp < @cutoff
    `);

    // actuator upsert handled via saveActuatorState method
  }

  public saveActuatorState(entry: { node?: string; pin?: string | number; running: boolean; duty?: number; updatedAt?: number }) {
    try {
      const stmt = this.database.prepare(`
        INSERT INTO actuators (node, pin, running, duty, updated_at)
        VALUES (@node, @pin, @running, @duty, @updated_at)
        ON CONFLICT(node, pin) DO UPDATE SET running = excluded.running, duty = excluded.duty, updated_at = excluded.updated_at
      `);

      stmt.run({
        node: entry.node ?? "",
        pin: entry.pin !== undefined ? String(entry.pin) : "",
        running: entry.running ? 1 : 0,
        duty: entry.duty ?? null,
        updated_at: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : new Date().toISOString(),
      });
    } catch (err) {
      console.error("Failed to persist actuator state", err);
    }
  }

  public loadActuatorStates(): Array<{ node?: string; pin?: string; running: boolean; duty?: number; updated_at: string }> {
    try {
      const rows = this.database.prepare(`SELECT node, pin, running, duty, updated_at FROM actuators`).all();
      return rows.map((r: any) => ({ node: r.node || undefined, pin: r.pin || undefined, running: !!r.running, duty: r.duty ?? undefined, updated_at: r.updated_at }));
    } catch (err) {
      console.error("Failed to load actuator states", err);
      return [];
    }
  }

  public saveSensorReading(reading: SensorReading) {
    const retentionMs = this.getRetentionWindowMs();
    const cutoff =
      retentionMs > 0 ? new Date(Date.now() - retentionMs).toISOString() : null;

    const tx = this.database.transaction(
      (payload: SensorReading, retentionCutoff: string | null) => {
        this.upsertSensorStatement.run({
          id: payload.id,
          type: payload.type,
        });

        this.insertReadingStatement.run({
          sensor_id: payload.id,
          timestamp: payload.timestamp,
          value:
            typeof payload.value === "boolean"
              ? Number(payload.value)
              : payload.value,
        });
        if (retentionCutoff) {
          this.deleteOldReadingsStatement.run({ cutoff: retentionCutoff });
        }
      }
    );

    tx(reading, cutoff);
    this.checkpointIfNeeded();
  }

  private getRetentionWindowMs(): number {
    const env = process.env.SENSOR_RETENTION_DAYS || "30";
    const days = env ? Number(env) : 30;
    if (!Number.isFinite(days) || days <= 0) return 0;
    return days * 24 * 60 * 60 * 1000;
  }

  private lastCheckpoint = 0;
  private checkpointIntervalMs = 6 * 60 * 60 * 1000;

  private checkpointIfNeeded() {
    const now = Date.now();
    if (now - this.lastCheckpoint < this.checkpointIntervalMs) return;
    try {
      this.database.pragma("wal_checkpoint(TRUNCATE)");
      this.lastCheckpoint = now;
    } catch (err) {
      console.error("Failed to checkpoint WAL", err);
    }
  }

  // ===== SETPOINTS MANAGEMENT =====

  private loadSetpoints() {
    try {
      const rows = this.database.prepare(`SELECT key, value_json FROM setpoints`).all() as Array<{ key: string; value_json: string }>;
      for (const row of rows) {
        try {
          this.setpointsCache.set(row.key, JSON.parse(row.value_json));
        } catch (err) {
          console.error(`Failed to parse setpoint '${row.key}'`, err);
        }
      }
      console.log(`Loaded ${this.setpointsCache.size} setpoints into cache`);
    } catch (err) {
      console.error("Failed to load setpoints", err);
    }
  }

  public getSetpoint<T = any>(key: string): T | undefined {
    return this.setpointsCache.get(key);
  }

  public setSetpoint(key: string, value: any): void {
    try {
      const valueJson = JSON.stringify(value);
      const stmt = this.database.prepare(`
        INSERT INTO setpoints (key, value_json, updated_at)
        VALUES (@key, @value_json, @updated_at)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `);
      stmt.run({ key, value_json: valueJson, updated_at: new Date().toISOString() });
      this.setpointsCache.set(key, value);
    } catch (err) {
      console.error(`Failed to persist setpoint '${key}'`, err);
    }
  }

  public getAllSetpoints(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of this.setpointsCache.entries()) {
      result[key] = value;
    }
    return result;
  }
}

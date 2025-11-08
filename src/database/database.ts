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

  constructor() {
    this.DATABASE_PATH = `${os.userInfo().homedir}/.ghw/data/greenhouse.db`;
    const dbExists = fs.existsSync(this.DATABASE_PATH);

    if (!dbExists) {
      this.initializeDatabase();
    }

    this.database = new Database(this.DATABASE_PATH);
    this.database.pragma("journal_mode = WAL");

    this.createTables();
    this.prepareStatements();
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
}

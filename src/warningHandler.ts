import { EventEmitter } from "stream";
import { IAlert } from "./types";

export class WarningHandler extends EventEmitter {
  private warnings: IAlert[] = [];

  constructor() {
    super();
  }

  public addWarning(warning: IAlert): IAlert {
    this.warnings.push(warning);
    return warning;
  }

  public issueWarning(warning: IAlert): void {
    this.emit("warning", warning);
  }

  public getWarnings(): IAlert[] {
    return this.warnings;
  }

  public clearWarnings(): void {
    this.warnings = [];
  }

  public hasWarnings(): boolean {
    return this.warnings.length > 0;
  }
}

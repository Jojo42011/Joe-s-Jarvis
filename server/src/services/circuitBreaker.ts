import { logExecution } from "../db/queries";
import { logServiceError } from "../utils/logError";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  readonly serviceName: string;

  constructor(serviceName: string) {
    super(`Circuit open for ${serviceName}`);
    this.name = "CircuitOpenError";
    this.serviceName = serviceName;
  }
}

const OPEN_MS = 60_000;
const FAILURE_THRESHOLD = 3;

class ServiceCircuit {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private openLogged = false;

  constructor(private readonly serviceName: string) {}

  getState(): CircuitState {
    if (this.state === "OPEN" && Date.now() - this.openedAt >= OPEN_MS) {
      this.state = "HALF_OPEN";
    }
    return this.state;
  }

  isOpen(): boolean {
    this.getState();
    return this.state === "OPEN";
  }

  graceMessage(): string {
    const label =
      this.serviceName === "Gmail"
        ? "Gmail"
        : this.serviceName === "Brave"
          ? "live search"
          : "Claude";
    return `Having trouble reaching ${label} sir, operating on what I have.`;
  }

  async execute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === "OPEN") {
      throw new CircuitOpenError(this.serviceName);
    }

    try {
      const result = await fn();
      if (this.state === "HALF_OPEN" || this.consecutiveFailures > 0) {
        const wasOpen = this.state === "OPEN" || this.openLogged;
        this.state = "CLOSED";
        this.consecutiveFailures = 0;
        this.openLogged = false;
        if (wasOpen) {
          logExecution({
            type: "system",
            action: `circuit.${this.serviceName.toLowerCase()}.closed`,
            summary: `[${this.serviceName}] Circuit closed after recovery (${operation})`,
            result: "success"
          });
        }
      }
      return result;
    } catch (error) {
      if (error instanceof CircuitOpenError) throw error;

      this.consecutiveFailures += 1;
      logServiceError(this.serviceName, operation, error);

      if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.state !== "OPEN") {
        this.state = "OPEN";
        this.openedAt = Date.now();
        if (!this.openLogged) {
          this.openLogged = true;
          logExecution({
            type: "system",
            action: `circuit.${this.serviceName.toLowerCase()}.open`,
            summary: `[${this.serviceName}] Circuit opened after ${FAILURE_THRESHOLD} failures (${operation})`,
            result: "failed"
          });
        }
      }
      throw error;
    }
  }
}

export const gmailCircuit = new ServiceCircuit("Gmail");
export const braveCircuit = new ServiceCircuit("Brave");
export const claudeCircuit = new ServiceCircuit("Claude");

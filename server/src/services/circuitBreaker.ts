import { getSystemState, logExecution, setSystemState } from "../db/queries";
import { isRateLimitError } from "../utils/rateLimit";
import { logServiceError } from "../utils/logError";
import { circuitLog } from "../utils/requestLog";

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
const PERSIST_OPEN_RECOVERY_MS = 5 * 60_000;
const FAILURE_THRESHOLD = 3;

class ServiceCircuit {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private openLogged = false;
  private rejectLogged = false;

  constructor(private readonly serviceName: string) {
    this.restoreFromPersistence();
  }

  private stateKey(): string {
    return `circuit_${this.serviceName}_state`;
  }

  private openedAtKey(): string {
    return `circuit_${this.serviceName}_opened_at`;
  }

  private restoreFromPersistence() {
    const persisted = getSystemState(this.stateKey());
    const openedAtStr = getSystemState(this.openedAtKey());
    if (persisted !== "OPEN" || !openedAtStr) return;

    const openedAt = Date.parse(openedAtStr);
    if (!Number.isFinite(openedAt)) return;

    this.openedAt = openedAt;
    const age = Date.now() - openedAt;
    if (age >= PERSIST_OPEN_RECOVERY_MS) {
      this.state = "HALF_OPEN";
      circuitLog(`${this.serviceName} circuit restored HALF_OPEN after restart (${Math.round(age / 1000)}s open)`);
    } else {
      this.state = "OPEN";
      this.openLogged = true;
      circuitLog(`${this.serviceName} circuit restored OPEN after restart (${Math.round(age / 1000)}s open)`);
    }
  }

  private persistClosed() {
    setSystemState(this.stateKey(), "CLOSED");
  }

  private persistOpen() {
    const now = new Date().toISOString();
    setSystemState(this.stateKey(), "OPEN");
    setSystemState(this.openedAtKey(), now);
  }

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

  /** After confirmed recovery (e.g. fresh OAuth token), allow requests immediately. */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.openLogged = false;
    this.rejectLogged = false;
    this.persistClosed();
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

  private markOpen(reason: string, operation: string) {
    this.state = "OPEN";
    this.openedAt = Date.now();
    this.rejectLogged = false;
    this.persistOpen();
    if (!this.openLogged) {
      this.openLogged = true;
      circuitLog(`${this.serviceName} circuit OPEN — ${reason} (${operation})`);
    }
  }

  async execute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === "OPEN") {
      if (!this.rejectLogged) {
        this.rejectLogged = true;
        circuitLog(`${this.serviceName} rejected call — circuit OPEN (${operation})`);
      }
      throw new CircuitOpenError(this.serviceName);
    }

    try {
      const result = await fn();
      if (this.state === "HALF_OPEN" || this.consecutiveFailures > 0) {
        const wasOpen = this.state === "OPEN" || this.openLogged;
        this.state = "CLOSED";
        this.consecutiveFailures = 0;
        this.openedAt = 0;
        this.openLogged = false;
        this.rejectLogged = false;
        this.persistClosed();
        if (wasOpen) {
          circuitLog(`${this.serviceName} circuit CLOSED — recovered (${operation})`);
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

      if (isRateLimitError(error)) {
        this.consecutiveFailures = FAILURE_THRESHOLD;
        if (!this.openLogged) {
          console.error(`[${this.serviceName}] Rate limited, backing off 60s`);
          logExecution({
            type: "system",
            action: `circuit.${this.serviceName.toLowerCase()}.rate_limit`,
            summary: `[${this.serviceName}] Rate limited, backing off 60s (${operation})`,
            result: "failed"
          });
        }
        this.markOpen("rate limited, backing off 60s", operation);
        throw error;
      }

      this.consecutiveFailures += 1;
      logServiceError(this.serviceName, operation, error);

      if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.state !== "OPEN") {
        this.markOpen(`${FAILURE_THRESHOLD} failures`, operation);
        logExecution({
          type: "system",
          action: `circuit.${this.serviceName.toLowerCase()}.open`,
          summary: `[${this.serviceName}] Circuit opened after ${FAILURE_THRESHOLD} failures (${operation})`,
          result: "failed"
        });
      }
      throw error;
    }
  }
}

export const gmailCircuit = new ServiceCircuit("Gmail");
export const braveCircuit = new ServiceCircuit("Brave");
export const claudeCircuit = new ServiceCircuit("Claude");

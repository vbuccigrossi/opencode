/**
 * Signal definitions and thresholds for the meta-cognitive monitor.
 *
 * Each signal represents a measurable aspect of agent behavior that
 * can indicate problems (going in circles, burning context, drifting
 * from goal). Signals are pure data — pattern detection logic is
 * in patterns.ts.
 */
export namespace MonitorSignals {
  /** A single warning to surface to the agent. */
  export interface Warning {
    /** Signal that triggered this warning */
    signal: SignalType
    /** Severity: info (FYI), warn (should address), critical (must address) */
    severity: "info" | "warn" | "critical"
    /** Human-readable message for the agent */
    message: string
  }

  /** Types of signals the monitor tracks. */
  export type SignalType =
    | "circular_edits"
    | "redundant_reads"
    | "verification_spiral"
    | "context_burn"
    | "goal_drift"
    | "unproductive_reads"

  /** Thresholds for when signals fire. */
  export interface Thresholds {
    /** Number of edits to same file before warning */
    circularEdits: number
    /** Number of reads of same file before warning */
    redundantReads: number
    /** Consecutive verification failures before warning */
    verificationSpiral: number
    /** Context usage percentage to warn at (0-1) */
    contextBurnWarn: number
    /** Context usage percentage for critical warning (0-1) */
    contextBurnCritical: number
    /** Steps of unrelated tool calls before goal drift warning */
    goalDriftSteps: number
    /** Number of files read but never used in edits */
    unproductiveReads: number
  }

  /** Default thresholds — tuned for typical coding sessions. */
  export const DEFAULT_THRESHOLDS: Thresholds = {
    circularEdits: 3,
    redundantReads: 3,
    verificationSpiral: 3,
    contextBurnWarn: 0.50,
    contextBurnCritical: 0.80,
    goalDriftSteps: 4,
    unproductiveReads: 8,
  }
}

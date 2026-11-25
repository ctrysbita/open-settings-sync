/** Failures callers can distinguish without parsing diagnostic messages. */
export type FailureCode =
  | "invalid-data"
  | "invalid-configuration"
  | "busy"
  | "cancelled"
  | "local-changed"
  | "remote-changed"
  | "process-failed"
  | "verification-failed";

/** Preserves the original cause while exposing a stable decision code. */
export class SyncFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SyncFailure";
  }
}

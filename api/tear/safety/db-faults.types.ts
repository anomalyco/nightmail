export type FaultMode =
  | "none"
  | "readonly_pg_readonly"
  | "readonly_25006"
  | "stall_57014"
  | "lock_55P03"
  | "pool_exhausted_53300"
  | "after_first_write_57014"
  | "after_second_write_57014";

export type SendKey = "k1" | "k2";

export type DbFaultAction =
  | { op: "SetFault"; mode: FaultMode }
  | { op: "Send"; key: SendKey }
  | { op: "SendSuppressed" }
  | { op: "CreateList" }
  | { op: "ReadMe" }
  | { op: "Drain" };

export interface DbFaultObs {
  status: number;
  code: string | null;
  retryable: boolean | null;
  emailId: string | null;
  duplicateKeyId: boolean;
  drained: boolean;
}

export interface DbFaultSnapshot {
  fault: FaultMode;
  acceptedIds: string[];
  deliveredIds: string[];
  doubleSentIds: string[];
  duplicateKeyIds: string[];
  doubleSentKeys: string[];
  lostAfterDrain: string[];
  nonRetryableFaultErrors: string[];
  leakedErrors: string[];
}

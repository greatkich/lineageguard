export interface WorkerHeartbeat {
  service: "worker";
  phase: "FOUNDATION";
  productReady: false;
  observedAt: string;
}

export function createWorkerHeartbeat(observedAt: string): WorkerHeartbeat {
  return {
    service: "worker",
    phase: "FOUNDATION",
    productReady: false,
    observedAt,
  };
}

export type HealthStatus = {
  status: "ok";
  service: string;
};

export function getHealth(): HealthStatus {
  return {
    status: "ok",
    service: "x360-esign",
  };
}

import type { FileServerStatus } from "../status-types.js";

export interface PidState {
  pid: number;
  startedAt: string;
  command: string;
  webui?: {
    pid: number;
    command: string;
    url: string;
  };
}

export type GatewayStatus = FileServerStatus;

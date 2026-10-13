// Shapes shared by the server routes and the browser UI. Type-only, so the
// client can import from here without pulling in any server code.

export interface CapturedRequest {
  id: string;
  binId: string;
  method: string;
  /** Path after /api/hook/<binId>, including query string. "/" when bare. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Body as text, or base64 when the payload isn't valid UTF-8. */
  body: string;
  bodyEncoding: "utf8" | "base64" | "none";
  bodyTruncated: boolean;
  contentType: string | null;
  /** Original body size in bytes, before any truncation. */
  size: number;
  ip: string | null;
  receivedAt: number;
}

/** What gets pushed to every open live stream for a bin. */
export type BinEvent =
  | { type: "request"; request: CapturedRequest }
  | { type: "cleared" };

export interface ReplayResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  durationMs: number;
  headers?: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
  error?: string;
}

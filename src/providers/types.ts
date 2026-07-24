export type ProviderName = "chatgpt" | "gemini";

export interface SessionStatus {
  provider: ProviderName;
  authenticated: boolean;
  /** Human-readable explanation (what was detected, what to do next). */
  details: string;
  /** Current page URL at the time of the check, for debugging. */
  url?: string;
}

export interface GenerateRequest {
  prompt: string;
  /** e.g. "16:9", "1:1", "9:16" — folded into the prompt, since web UIs have no reliable aspect-ratio control. */
  aspectRatio?: string;
  /** When set, this is an edit: the image is uploaded before the prompt is sent. */
  inputImagePath?: string;
  /** Overall deadline for this generation, ms. */
  timeoutMs: number;
  /** Per-job log sink (also mirrored to the server log). */
  log: (message: string) => void;
}

export interface CapturedImage {
  buffer: Buffer;
  contentType: string;
  /** URL the image was downloaded from, when applicable. */
  sourceUrl?: string;
  /**
   * "download" = actual generated file fetched from the page (full quality).
   * "screenshot" = element screenshot fallback (lower fidelity, reported honestly).
   */
  captureMethod: "download" | "screenshot";
}

export interface ImageProvider {
  readonly name: ProviderName;
  /** Non-destructive check: is the persistent session logged in and usable? */
  checkSession(): Promise<SessionStatus>;
  /**
   * Open the provider's site and wait for the user to authenticate manually.
   * Never touches credentials, CAPTCHAs, or MFA — it just waits and re-checks.
   */
  waitForLogin(timeoutMs: number): Promise<SessionStatus>;
  /** Generate (or edit, when inputImagePath is set) and return the raw image bytes. */
  generate(req: GenerateRequest): Promise<CapturedImage[]>;
}

export const ACTIVITY_KEY: string;
export const MAX_RESULT_CHARS: number;
export const TOOL_FOR_COMMAND: Record<string, string>;
export function describeResult(reply: { ok: boolean; data?: unknown; error?: string }): {
  result: string;
  resultTruncated: boolean;
};
export function recordActivity(entry: unknown): Promise<void>;
export function clearActivity(): Promise<void>;

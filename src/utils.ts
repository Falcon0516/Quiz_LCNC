import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a 6-character human-friendly join code (uppercase alphanumeric, no ambiguous chars).
 * Excludes 0, O, I, L, 1 to avoid readability issues on projectors.
 */
export function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Generate a unique participant token for reconnection.
 */
export function generateToken(): string {
  return uuidv4();
}

/**
 * Generate a unique ID for a quiz config.
 */
export function generateQuizId(): string {
  return uuidv4();
}

/**
 * Timestamp logger for lifecycle events.
 */
export function log(event: string, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const detailStr = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[${timestamp}] ${event}${detailStr}`);
}

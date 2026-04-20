/**
 * Logger helpers for consistent pi-cleanup warning prefixes.
 *
 * @module
 */

/**
 * Write a namespaced warning to stderr via `console.warn`.
 *
 * @param context - A short tag describing the warning source.
 * @param message - The warning message payload.
 */
export const warn = (context: string, message: string): void => {
  console.warn(`[pi-cleanup] ${context}: ${message}`);
};

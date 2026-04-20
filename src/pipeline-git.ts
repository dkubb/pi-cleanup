/**
 * Git helpers used by the cleanup pipeline orchestrator.
 *
 * @module
 */

export { isGitRepo } from "./phases/dirty-tree.js";
export { isGitUnchanged, resolveBaseSHA } from "./phases/git-status.js";

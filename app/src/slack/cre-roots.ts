import type { InstanceConfig } from "../config/config.js";
import type { PaneInfo } from "../herdr/types.js";

/**
 * CRE runs Pi internally and deliberately advertises process.title="pi".
 * Pi identification alone does not attest the CRE launcher. An operator must
 * verify the process and pin both the stable Herdr terminal and native Pi
 * session reference. Replacing the process or switching session fails closed.
 */
export function isEligibleCreRoot(config: InstanceConfig, pane: PaneInfo | undefined): boolean {
  if (!pane?.agent) return false;
  if (!config.creOnly) return true;
  const native = pane.agent_session;
  if (pane.agent !== "pi" || native?.agent !== "pi" || !native.value) return false;
  return (config.creRoots ?? []).some((root) =>
    root.workspaceId === pane.workspace_id && root.terminalId === pane.terminal_id &&
    root.sessionId === native.value,
  );
}

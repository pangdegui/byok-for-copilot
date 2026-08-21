/**
 * Tool-flow constants — see tools/flow.ts for the corrected naming/purpose.
 *
 * preflight's real job is to **compress the first-round `activate_*` virtual
 * tool list** for models that are weak/don't actively call tools — NOT to answer
 * real tools on Copilot's behalf. Ordinary tools are just passed through.
 */

/** Prefix of Copilot's virtual "activate agent/skill" tools. */
export const ACTIVATE_TOOL_PREFIX = 'activate_';
/** Prefix used to mint preflight "activate" tool-call ids. */
export const PREFLIGHT_ACTIVATE_CALL_ID_PREFIX = 'byok_preflight_activate_';
/** Safety cap on preflight rounds per user request. */
export const MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST = 3;

export const TOOL_DRIFT_NOTICE_START = '[byok-copilot-tool-drift-notice-start]: #';
export const TOOL_DRIFT_NOTICE_END = '[byok-copilot-tool-drift-notice-end]: #';
export const VISION_PROXY_NOTICE_START = '[byok-copilot-vision-proxy-notice-start]: #';
export const VISION_PROXY_NOTICE_END = '[byok-copilot-vision-proxy-notice-end]: #';

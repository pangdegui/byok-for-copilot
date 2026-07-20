// Maximum number of functions supported in a single tools request (128 is common for most providers).
export const TOOLS_LIMIT = 128;

export const ACTIVATE_TOOL_PREFIX = 'activate_';
export const PREFLIGHT_ACTIVATE_CALL_ID_PREFIX = 'byok_preflight_activate_';
export const MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST = 3;

export const TOOL_DRIFT_NOTICE_START = '[byok-copilot-tool-drift-notice-start]: #';
export const TOOL_DRIFT_NOTICE_END = '[byok-copilot-tool-drift-notice-end]: #';
export const VISION_PROXY_NOTICE_START = '[byok-copilot-vision-proxy-notice-start]: #';
export const VISION_PROXY_NOTICE_END = '[byok-copilot-vision-proxy-notice-end]: #';

// Backward-compatible re-export: logger implementation now lives in
// `profile/log` (⑤ profile 遥测层). Keep this shim so existing callers using
// `import { logger } from '../logger'` keep working after the Phase 5 relocation.
export { logger } from './profile/log';

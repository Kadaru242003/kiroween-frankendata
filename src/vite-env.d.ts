/// <reference types="vite/client" />

/**
 * Typed build-time environment variables exposed to the client bundle (Vite
 * only exposes variables prefixed with `VITE_`). See `.env.example` and
 * `DEPLOY.md` for meanings.
 */
interface ImportMetaEnv {
  /**
   * Client kill-switch for the optional AI match-refinement enhancement. Only
   * the exact string `"true"` enables the AI call via `/api/ai`; anything else
   * (including unset) means rules-only with no network attempt. Build-time, so
   * changing it requires a re-deploy.
   */
  readonly VITE_AI_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

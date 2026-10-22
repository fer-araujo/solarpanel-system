/**
 * Identifies the build, injected by `define` in vite.config.ts. Busts the
 * persisted query cache on every deploy.
 */
declare const __APP_BUILD__: string;

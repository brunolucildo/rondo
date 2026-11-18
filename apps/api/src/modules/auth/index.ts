/** Public surface of the auth module. */
export { AuthModule } from "./auth.module";
export { createAuthTelemetryMiddleware } from "./interface/auth-telemetry.middleware";
export { CurrentSession } from "./interface/current-session.decorator";
export type { ActiveSession } from "./domain/session-ports";

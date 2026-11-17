import { LOCAL_DATABASE_URL } from "./support/local-database-url";

process.env.DATABASE_URL ??= LOCAL_DATABASE_URL;
process.env.APP_URL ??= "http://localhost:5173";
// Vitest already sets it; stated so the e-mail provider is `capture` (no network) by contract.
process.env.NODE_ENV ??= "test";
process.env.EMAIL_FROM ??= "Rondo <no-reply@rondo.local>";
process.env.OTEL_SDK_DISABLED ??= "true";
process.env.LOG_LEVEL ??= "silent";
process.env.TRUST_PROXY ??= "false";
process.env.AUTH_JWT_SECRET ??= "test-only-jwt-secret-0123456789-abcdefghij";
// The `knowledge` module (imported by the app) needs the Weaviate URL and key; the default is the
// development container, opened only when a test really talks to the index.
process.env.WEAVIATE_URL ??= "http://localhost:8080";
process.env.WEAVIATE_API_KEY ??= "rondo-dev-weaviate-key";

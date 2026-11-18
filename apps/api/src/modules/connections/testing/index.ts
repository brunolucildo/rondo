/** Test doubles and fixtures of the connections module, kept out of the public barrel. */
export { buildPdf, buildProtectedPdf, sentences, wrapLines } from "./pdf-fixtures";
export { InMemoryConnectionRepository } from "./in-memory-connection.repository";
export {
  createScriptedWeb,
  FAKE_PUBLIC_ADDRESS,
  FakeDnsResolver,
  FakeHttpTransport,
  gzipped,
} from "../infrastructure/fake-web";

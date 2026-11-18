import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline, type Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { EGRESS_REQUEST } from "../../../observability/egress-requests";
import type {
  DnsResolver,
  HttpTransport,
  TransportRequest,
  TransportResponse,
} from "../domain/url-fetch";

const noop = (): void => undefined;

/** The system resolver: every address (A and AAAA) of a name, in the order the system gives. */
export class SystemDnsResolver implements DnsResolver {
  async resolve(hostname: string): Promise<string[]> {
    const answers = await lookup(hostname, { all: true, verbatim: true });

    return answers.map((answer) => answer.address);
  }
}

function decoderOf(encoding: string | undefined): Transform | null {
  switch (encoding?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new Error("Unsupported content encoding.");
  }
}

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Every connection goes to the address the caller validated, whatever the name resolves to now. */
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all === true) {
      callback(null, [{ address, family }]);

      return;
    }

    callback(null, address, family);
  };
}

/**
 * One HTTP(S) request over `node:http`/`node:https` to a given address (spec 0027, R3). The name
 * stays in the `Host` header and in the TLS server name (the certificate is checked against it),
 * but the socket is opened to `address`: there is no second DNS lookup. No connection pooling
 * (`agent: false`), so a socket opened for one link is never reused for another. The body is
 * decompressed here (gzip, deflate, Brotli) as a stream: the caller counts the decoded bytes and
 * stops reading at its limit, which is what bounds a decompression bomb. Redirects are not
 * followed: the caller does that, checking each hop.
 */
export class NodeHttpTransport implements HttpTransport {
  request({ url, address, family, headers, signal }: TransportRequest): Promise<TransportResponse> {
    return new Promise<TransportResponse>((resolve, reject) => {
      const secure = url.protocol === "https:";
      const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
      const options: RequestOptions & { [EGRESS_REQUEST]?: boolean } = {
        method: "GET",
        host: hostname,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        lookup: pinnedLookup(address, family),
        signal,
        [EGRESS_REQUEST]: true,
      };
      const send = secure ? httpsRequest : httpRequest;
      const clientRequest = send(options, (response: IncomingMessage) => {
        let body: Readable = response;

        // An aborted transfer errors the message; whoever reads the body hears it, nobody else must crash.
        response.on("error", noop);

        try {
          const decoder = decoderOf(firstHeader(response.headers["content-encoding"]));

          if (decoder !== null) {
            body = pipeline(response, decoder, noop);
          }
        } catch (error) {
          response.destroy();
          reject(error);

          return;
        }

        const flat: Record<string, string | undefined> = {};

        for (const [name, value] of Object.entries(response.headers)) {
          flat[name] = firstHeader(value);
        }

        resolve({
          status: response.statusCode ?? 0,
          headers: flat,
          body,
          close: () => {
            body.destroy();
            response.destroy();
            clientRequest.destroy();
          },
        });
      });

      clientRequest.on("error", reject);
      clientRequest.end();
    });
  }
}

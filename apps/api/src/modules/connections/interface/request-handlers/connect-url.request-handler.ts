import { Body, Controller, HttpStatus, Inject, Post, Res } from "@nestjs/common";
import { ApiException } from "../../../../common/api-exception";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { RateLimit } from "../../../rate-limit";
import { ConnectUrl } from "../../application/use-cases/connect-url.use-case";
import {
  ConnectionLimitReachedError,
  ConnectionProcessingError,
} from "../../domain/connection-errors";
import { InvalidUrlError, UrlNotAllowedError } from "../../domain/external-url";
import { UrlFetchError } from "../../domain/url-fetch";
import { ConnectUrlDto } from "../dto/connect-url.dto";
import { presentUpload, type UploadConnectionResponse } from "../presenters/connection.presenter";

interface StatusResponse {
  status(code: number): unknown;
}

const URL_NOT_ALLOWED = () =>
  new ApiException(HttpStatus.BAD_REQUEST, "URL_NOT_ALLOWED", "This link can't be used.");

/** What each failure to read a link says: fixed messages, never the link or what the server sent. */
const UNPROCESSABLE: Readonly<Record<string, string>> = {
  FETCH_FAILED: "We couldn't open this link.",
  FETCH_TIMEOUT: "The page took too long to answer.",
  RESPONSE_TOO_LARGE: "This page is larger than 5 MB.",
  UNSUPPORTED_CONTENT_TYPE: "Only web pages, text, Markdown and PDF links are supported.",
  TOO_MANY_REDIRECTS: "This link redirects too many times.",
  NO_EXTRACTABLE_TEXT: "We couldn't find any text on this page.",
  PDF_PROTECTED: "This PDF is protected by a password.",
};

@Controller("connections")
export class ConnectUrlRequestHandler {
  constructor(@Inject(ConnectUrl) private readonly connectUrl: ConnectUrl) {}

  /**
   * Connects a link (JSON `{ "url": "..." }`). The link is validated and fetched here, with the
   * protections of the egress policy; indexing runs in the background. `200` when the link (or its
   * text) was already connected and is settled, `202` while it is processing. `400 INVALID_URL`
   * for a link that is not a plain http(s) link, `400 URL_NOT_ALLOWED` for a destination that is
   * not public (also after a redirect), `422` with the code of what went wrong when the page could
   * not be read. Limited per IP: the limiter runs before authentication.
   */
  @Post("url")
  @RateLimit("connection-url")
  async handle(
    @Body() body: ConnectUrlDto,
    @CurrentSession() session: ActiveSession,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<UploadConnectionResponse> {
    try {
      const { connection, deduplicated } = await this.connectUrl.execute({
        userId: session.userId,
        url: body.url,
      });

      response.status(connection.status === "processing" ? HttpStatus.ACCEPTED : HttpStatus.OK);

      return presentUpload(connection, deduplicated);
    } catch (error) {
      throw translate(error);
    }
  }
}

function translate(error: unknown): unknown {
  if (error instanceof InvalidUrlError) {
    return new ApiException(
      HttpStatus.BAD_REQUEST,
      "INVALID_URL",
      "Enter a valid http or https link.",
    );
  }

  if (error instanceof UrlNotAllowedError) {
    return URL_NOT_ALLOWED();
  }

  if (error instanceof UrlFetchError && error.code === "URL_NOT_ALLOWED") {
    return URL_NOT_ALLOWED();
  }

  if (error instanceof ConnectionLimitReachedError) {
    return new ApiException(
      HttpStatus.CONFLICT,
      "CONNECTION_LIMIT_REACHED",
      "You reached the limit of 50 connections.",
    );
  }

  if (error instanceof UrlFetchError || error instanceof ConnectionProcessingError) {
    const message = UNPROCESSABLE[error.code];

    if (message !== undefined) {
      return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, error.code, message);
    }

    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      "PROCESSING_UNAVAILABLE",
      "We couldn't process this link right now. Try again in a moment.",
    );
  }

  return error;
}

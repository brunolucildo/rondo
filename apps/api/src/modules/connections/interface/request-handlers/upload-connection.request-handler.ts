import {
  Controller,
  HttpStatus,
  Inject,
  Post,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { MulterOptions } from "@nestjs/platform-express/multer/interfaces/multer-options.interface";
import { ApiException } from "../../../../common/api-exception";
import { type ActiveSession, CurrentSession } from "../../../auth";
import { RateLimit } from "../../../rate-limit";
import { UploadConnection } from "../../application/use-cases/upload-connection.use-case";
import {
  ConnectionLimitReachedError,
  InvalidUploadError,
  MediaDailyLimitError,
  MediaUnavailableError,
  TooManyProcessingError,
} from "../../domain/connection-errors";
import {
  isAcceptedUpload,
  kindOfFileName,
  MAX_BYTES_BY_KIND,
  MAX_UPLOAD_BYTES,
} from "../../domain/connection-rules";
import { presentUpload, type UploadConnectionResponse } from "../presenters/connection.presenter";
import { UploadExceptionFilter } from "../upload-exception.filter";

/** The part of an uploaded file this handler reads (memory storage: the whole file in `buffer`). */
interface UploadedFileLike {
  originalname: string;
  buffer: Buffer;
}

interface StatusResponse {
  status(code: number): unknown;
}

const UNSUPPORTED_FILE = () =>
  new ApiException(
    HttpStatus.BAD_REQUEST,
    "UNSUPPORTED_FILE",
    "Only PDF, TXT, Markdown, MP3 and MP4 files are supported.",
  );

const UPLOAD_OPTIONS: MulterOptions = {
  // One file, no other fields. The multipart limit is the largest of the kinds (200 MB); the use
  // case then applies the limit of the kind of the file (20 MB documents, 50 MB MP3).
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
  // Browsers send the name as UTF-8; multer would read it as Latin-1.
  defParamCharset: "utf8",
  // Extension and content type are checked before the content is read.
  fileFilter: (_request, file, callback) => {
    callback(isAcceptedUpload(file.originalname, file.mimetype) ? null : UNSUPPORTED_FILE(), true);
  },
};

function invalidUploadException(code: InvalidUploadError["code"], fileName: string): ApiException {
  switch (code) {
    case "FILE_TOO_LARGE": {
      const kind = kindOfFileName(fileName);
      const megabytes =
        (kind === null ? MAX_UPLOAD_BYTES : MAX_BYTES_BY_KIND[kind]) / (1024 * 1024);

      return new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        "FILE_TOO_LARGE",
        `The file is larger than ${megabytes} MB.`,
      );
    }
    case "EMPTY_FILE":
      return new ApiException(HttpStatus.BAD_REQUEST, "EMPTY_FILE", "The file is empty.");
    case "MEDIA_TOO_LONG":
      return new ApiException(
        HttpStatus.BAD_REQUEST,
        "MEDIA_TOO_LONG",
        "Audio can have at most 60 minutes and video at most 20 minutes.",
      );
    case "MEDIA_UNREADABLE":
      return new ApiException(
        HttpStatus.BAD_REQUEST,
        "MEDIA_UNREADABLE",
        "We couldn't read the length of this file. Export it again and try again.",
      );
    default:
      return UNSUPPORTED_FILE();
  }
}

@Controller("connections")
export class UploadConnectionRequestHandler {
  constructor(@Inject(UploadConnection) private readonly uploadConnection: UploadConnection) {}

  /**
   * Connects one file (`multipart/form-data`, field `file`). Validation of the multipart body
   * (type, size, a single file) happens in the interceptor; the use case checks the signature of the
   * bytes and the limits, decides between reuse and processing, and returns at once: `200` when
   * the connection already exists and is settled, `202` while it is processing. Limited per IP: the
   * limiter runs before authentication.
   */
  @Post()
  @RateLimit("connection-upload")
  @UseFilters(UploadExceptionFilter)
  @UseInterceptors(FileInterceptor("file", UPLOAD_OPTIONS))
  async handle(
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentSession() session: ActiveSession,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<UploadConnectionResponse> {
    if (file === undefined) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "The request is invalid.",
        [{ field: "file", message: "A single file is required." }],
      );
    }

    try {
      const { connection, deduplicated } = await this.uploadConnection.execute({
        userId: session.userId,
        fileName: file.originalname,
        bytes: file.buffer,
      });

      response.status(connection.status === "processing" ? HttpStatus.ACCEPTED : HttpStatus.OK);

      return presentUpload(connection, deduplicated);
    } catch (error) {
      if (error instanceof InvalidUploadError) {
        throw invalidUploadException(error.code, file.originalname);
      }

      if (error instanceof ConnectionLimitReachedError) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "CONNECTION_LIMIT_REACHED",
          "You reached the limit of 50 connections.",
        );
      }

      if (error instanceof MediaUnavailableError) {
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          "MEDIA_UNAVAILABLE",
          "Audio and video are not available right now.",
        );
      }

      if (error instanceof TooManyProcessingError) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "TOO_MANY_PROCESSING",
          "You already have 2 audio or video files being processed. Wait for one to finish.",
        );
      }

      if (error instanceof MediaDailyLimitError) {
        throw new ApiException(
          HttpStatus.TOO_MANY_REQUESTS,
          "MEDIA_DAILY_LIMIT",
          "You reached the daily limit of 100 minutes of audio and video.",
        );
      }

      throw error;
    }
  }
}

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
import { ConnectionLimitReachedError, InvalidUploadError } from "../../domain/connection-errors";
import { isAcceptedUpload, kindOfFileName, MAX_FILE_BYTES } from "../../domain/connection-rules";
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
    "Only PDF, TXT, Markdown, JPG and PNG files are supported.",
  );

const UPLOAD_OPTIONS: MulterOptions = {
  // One file, no other fields; one byte above the limit is enough to tell the file is too large.
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 1 },
  // Browsers send the name as UTF-8; multer would read it as Latin-1.
  defParamCharset: "utf8",
  // Extension and content type are checked before the content is read.
  fileFilter: (_request, file, callback) => {
    callback(isAcceptedUpload(file.originalname, file.mimetype) ? null : UNSUPPORTED_FILE(), true);
  },
};

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
        throw error.code === "FILE_TOO_LARGE"
          ? new ApiException(
              HttpStatus.PAYLOAD_TOO_LARGE,
              "FILE_TOO_LARGE",
              kindOfFileName(file.originalname) === "image"
                ? "The image is larger than 10 MB."
                : "The file is larger than 20 MB.",
            )
          : error.code === "IMAGE_TOO_LARGE"
            ? new ApiException(
                HttpStatus.BAD_REQUEST,
                "IMAGE_TOO_LARGE",
                "The image is larger than 8,000 pixels on a side.",
              )
            : error.code === "EMPTY_FILE"
              ? new ApiException(HttpStatus.BAD_REQUEST, "EMPTY_FILE", "The file is empty.")
              : UNSUPPORTED_FILE();
      }

      if (error instanceof ConnectionLimitReachedError) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "CONNECTION_LIMIT_REACHED",
          "You reached the limit of 50 connections.",
        );
      }

      throw error;
    }
  }
}

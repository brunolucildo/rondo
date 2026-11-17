import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  PayloadTooLargeException,
} from "@nestjs/common";
import { AllExceptionsFilter } from "../../../common/all-exceptions.filter";
import { ApiException } from "../../../common/api-exception";

/** What the multipart parser (busboy) says when the body is not a well formed form. */
const MALFORMED_MULTIPART = /^(Multipart:|Unexpected end of form|Malformed part header)/;

/**
 * Gives the errors of the multipart parser the same envelope as every other error: a file above
 * the limit is `413 FILE_TOO_LARGE` and a broken form is `400 VALIDATION_FAILED`. Anything else goes
 * to the global filter untouched.
 */
@Catch()
export class UploadExceptionFilter implements ExceptionFilter {
  private readonly global = new AllExceptionsFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof PayloadTooLargeException) {
      this.global.catch(
        new ApiException(
          HttpStatus.PAYLOAD_TOO_LARGE,
          "FILE_TOO_LARGE",
          "The file is larger than 20 MB.",
        ),
        host,
      );

      return;
    }

    if (exception instanceof Error && MALFORMED_MULTIPART.test(exception.message)) {
      this.global.catch(
        new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "The request is invalid.", [
          { field: "file", message: "A single file is required." },
        ]),
        host,
      );

      return;
    }

    this.global.catch(exception, host);
  }
}

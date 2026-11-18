import { IsString, MaxLength } from "class-validator";
import { MAX_URL_LENGTH } from "../../domain/external-url";

/**
 * Body of `POST /api/v1/connections/url`: the link. Whether it is acceptable (scheme, port, host)
 * is decided by the use case (`400 INVALID_URL` or `400 URL_NOT_ALLOWED`); here only its type and
 * its length. Any other property, a `userId` included, is rejected by the global pipe.
 */
export class ConnectUrlDto {
  @IsString({ message: "Link must be text." })
  @MaxLength(MAX_URL_LENGTH, {
    message: `Links must have at most ${MAX_URL_LENGTH} characters.`,
  })
  url!: string;
}

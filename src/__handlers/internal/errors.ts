import * as Data from "effect/Data";

type HttpHandlerErrorCode = [
  "undefined_body", "missing_required_query_parameter", "undefined_content_type",
  "unsupported_content_type"
][number]

export class HttpHandlerError
  extends Data.TaggedError("HttpHandlerError")<{
    code: HttpHandlerErrorCode,
    cause?: unknown
  }> { }

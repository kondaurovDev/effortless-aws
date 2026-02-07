import { Cause, Either, identity } from "effect";
import type * as Lambda from "aws-lambda";

const errorToBody = (error: unknown): string => {
  if (Cause.isCause(error)) return Cause.pretty(error, { renderErrorCause: true })
  if (error instanceof Error) return error.message
  return "Unknown exception was thrown"
}

export const mapToHttpResponse = <O, E>(
  result: Either.Either<O, E>
): Lambda.APIGatewayProxyStructuredResultV2 => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(Either.match(result, { onLeft: errorToBody, onRight: identity })),
  statusCode: Either.isRight(result) ? 200 : 400
})

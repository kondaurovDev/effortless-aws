// HTTP handlers
export { defineHttp } from "./define-http";
export type {
  HttpConfig,
  HttpRequest,
  HttpResponse,
  HttpMethod,
  HttpHandler,
  HttpHandlerFn,
  DefineHttpOptions,
} from "./define-http";
export type { ResolveDeps } from "./handler-deps";

// Table handlers
export { defineTable } from "./define-table";
export type {
  TableConfig,
  TableRecord,
  TableHandler,
  StreamView,
  DefineTableOptions,
  TableRecordFn,
  TableBatchFn,
  TableBatchCompleteFn,
  FailedRecord
} from "./define-table";

// FIFO Queue handlers
export { defineFifoQueue } from "./define-fifo-queue";
export type {
  FifoQueueConfig,
  FifoQueueMessage,
  FifoQueueHandler,
  FifoQueueMessageFn,
  FifoQueueBatchFn,
  DefineFifoQueueOptions
} from "./define-fifo-queue";

// Mailer handlers
export { defineMailer } from "./define-mailer";
export type { MailerConfig, MailerHandler } from "./define-mailer";

// Table client
export type { TableClient, QueryParams } from "../runtime/table-client";

// Email client
export type { EmailClient, SendEmailOptions } from "../runtime/email-client";

// Helpers
export { typed } from "./handler-options";

// Permissions
export type { Permission } from "./handler-options";

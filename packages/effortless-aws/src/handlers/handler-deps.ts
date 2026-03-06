import type { TableHandler } from "./define-table";
import type { BucketHandler } from "./define-bucket";
import type { MailerHandler } from "./define-mailer";
import type { FifoQueueHandler } from "./define-fifo-queue";
import type { TableClient } from "../runtime/table-client";
import type { BucketClient } from "../runtime/bucket-client";
import type { EmailClient } from "../runtime/email-client";
import type { QueueClient } from "../runtime/queue-client";

/** Dep value types supported by the deps declaration */
export type AnyDepHandler = TableHandler<any, any> | BucketHandler<any> | MailerHandler | FifoQueueHandler<any, any>;

/** Maps a deps declaration to resolved runtime client types */
export type ResolveDeps<D> = {
  [K in keyof D]: D[K] extends TableHandler<infer T> ? TableClient<T>
    : D[K] extends BucketHandler ? BucketClient
    : D[K] extends MailerHandler ? EmailClient
    : D[K] extends FifoQueueHandler<infer T> ? QueueClient<T>
    : never;
};

import type { TableHandler } from "./define-table";
import type { BucketHandler } from "./define-bucket";
import type { MailerHandler } from "./define-mailer";
import type { QueueHandler } from "./define-queue";
import type { WorkerHandler } from "./define-worker";
import type { TableClient } from "../runtime/table-client";
import type { BucketClient, BucketClientWithEntities } from "../runtime/bucket-client";
import type { EmailClient } from "../runtime/email-client";
import type { QueueClient } from "../runtime/queue-client";
import type { WorkerClient } from "../runtime/worker-client";

/** Dep value types supported by the deps declaration */
export type AnyDepHandler = TableHandler<any, any> | BucketHandler<any, any> | MailerHandler | QueueHandler<any, any> | WorkerHandler<any, any>;

/** Maps a deps declaration to resolved runtime client types */
export type ResolveDeps<D> = {
  [K in keyof D]: D[K] extends TableHandler<infer T> ? TableClient<T>
    : D[K] extends BucketHandler<any, infer E> ? ({} extends E ? BucketClient : BucketClientWithEntities<E>)
    : D[K] extends MailerHandler ? EmailClient
    : D[K] extends QueueHandler<infer T> ? QueueClient<T>
    : D[K] extends WorkerHandler<infer T> ? WorkerClient<T>
    : never;
};

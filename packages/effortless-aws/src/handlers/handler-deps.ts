import type { TableHandler } from "./define-table";
import type { BucketHandler } from "./define-bucket";
import type { MailerHandler } from "./define-mailer";
import type { TableClient } from "../runtime/table-client";
import type { BucketClient } from "../runtime/bucket-client";
import type { EmailClient } from "../runtime/email-client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTableHandler = TableHandler<any, any, any, any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBucketHandler = BucketHandler<any, any, any, any>;
export type AnyMailerHandler = MailerHandler;

/** Dep value types supported by the deps declaration */
export type AnyDepHandler = AnyTableHandler | AnyBucketHandler | AnyMailerHandler;

/** Maps a deps declaration to resolved runtime client types */
export type ResolveDeps<D> = {
  [K in keyof D]: D[K] extends TableHandler<infer T, any, any, any, any> ? TableClient<T>
    : D[K] extends BucketHandler<any, any, any, any> ? BucketClient
    : D[K] extends MailerHandler ? EmailClient
    : never;
};

import type { TableHandler } from "./define-table";
import type { BucketHandler } from "./define-bucket";
import type { TableClient } from "../runtime/table-client";
import type { BucketClient } from "../runtime/bucket-client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTableHandler = TableHandler<any, any, any, any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBucketHandler = BucketHandler<any, any, any, any>;

export type AnyDepHandler = AnyTableHandler | AnyBucketHandler;

/** Maps a deps declaration to resolved runtime client types */
export type ResolveDeps<D> = {
  [K in keyof D]: D[K] extends TableHandler<infer T, any, any, any, any> ? TableClient<T>
    : D[K] extends BucketHandler<any, any, any, any> ? BucketClient
    : never;
};

/** Service for reading static files bundled into the Lambda ZIP */
export type StaticFiles = {
  /** Read file as UTF-8 string */
  read(path: string): string;
  /** Read file as Buffer (for binary content) */
  readBuffer(path: string): Buffer;
  /** Resolve absolute path to the bundled file */
  path(path: string): string;
};

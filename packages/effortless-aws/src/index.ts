// Config
export type { EffortlessConfig } from "./config"
export { defineConfig } from "./config"

// Handlers
export { defineTable } from "./handlers/define-table"
export { defineApp } from "./handlers/define-app"
export { defineStaticSite } from "./handlers/define-static-site"
export { defineFifoQueue } from "./handlers/define-fifo-queue"
export { defineBucket } from "./handlers/define-bucket"
export { defineMailer } from "./handlers/define-mailer"
export { defineApi } from "./handlers/define-api"
export { defineCron } from "./handlers/define-cron"
export { defineWorker } from "./handlers/define-worker"
export { defineSecret, secret, param, generateHex, generateBase64, generateUuid } from "./handlers/handler-options"
export { toSeconds } from "./handlers/handler-options"

// Types
export type { HttpRequest, HttpResponse, HttpMethod, ContentType } from "./handlers/shared"
export type { TableConfig, TableRecord, StreamView } from "./handlers/define-table"
export type { AppConfig, AppHandler } from "./handlers/define-app"
export type { StaticSiteConfig, StaticSiteSeo, StaticSiteHandler, MiddlewareRequest, MiddlewareResult, MiddlewareRedirect, MiddlewareDeny, MiddlewareHandler } from "./handlers/define-static-site"
export type { FifoQueueConfig, FifoQueueMessage } from "./handlers/define-fifo-queue"
export type { BucketConfig, BucketEvent } from "./handlers/define-bucket"
export type { MailerConfig, MailerHandler } from "./handlers/define-mailer"
export type { ApiAuthConfig, ApiConfig, ApiHandler, ApiRoutes } from "./handlers/define-api"
export type { CronConfig } from "./handlers/define-cron"
export type { WorkerConfig } from "./handlers/define-worker"

// Handler types — re-exported without internal generic C
import type { TableHandler as _TableHandler } from "./handlers/define-table"
import type { FifoQueueHandler as _FifoQueueHandler } from "./handlers/define-fifo-queue"
import type { BucketHandler as _BucketHandler } from "./handlers/define-bucket"
import type { CronHandler as _CronHandler } from "./handlers/define-cron"
import type { WorkerHandler as _WorkerHandler } from "./handlers/define-worker"
export type TableHandler<T = Record<string, unknown>> = _TableHandler<T, any>
export type FifoQueueHandler<T = unknown> = _FifoQueueHandler<T, any>
export type BucketHandler = _BucketHandler<any>
export type CronHandler = _CronHandler<any>
export type WorkerHandler<T = any> = _WorkerHandler<T, any>
export type { Timezone } from "./handlers/timezone"
export type { TableClient, QueryParams, QueryByTagParams, SkCondition, UpdateActions, PutOptions } from "./runtime/table-client"
export type { BucketClient } from "./runtime/bucket-client"
export type { QueueClient, SendMessageInput } from "./runtime/queue-client"
export type { EmailClient, SendEmailOptions } from "./runtime/email-client"
export type { WorkerClient, WorkerSendOptions } from "./runtime/worker-client"
export type { Duration, SecretRef, ParamRef, TableKey, TableItem, PutInput, ConfigHelpers, DefineSecretFn } from "./handlers/handler-options"
export type { StaticFiles, ResponseStream } from "./handlers/shared"

// Shared types
export type { LogLevel, Permission } from "./handlers/handler-options"
export type { AuthHelpers } from "./handlers/auth"

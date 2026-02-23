/**
 * Configuration options for defining a mailer (SES email identity)
 */
export type MailerConfig = {
  /** Domain to verify and send emails from (e.g., "myapp.com") */
  domain: string;
};

/**
 * Internal handler object created by defineMailer
 * @internal
 */
export type MailerHandler = {
  readonly __brand: "effortless-mailer";
  readonly __spec: MailerConfig;
};

/**
 * Define an email sender backed by Amazon SES.
 *
 * Creates an SES Email Identity for the specified domain and provides
 * a typed `EmailClient` to other handlers via `deps`.
 *
 * On first deploy, DKIM DNS records are printed to the console.
 * Add them to your DNS provider to verify the domain.
 *
 * @param options - Mailer configuration with the domain to send from
 * @returns Handler object used by the deployment system and as a `deps` value
 *
 * @example Basic mailer with HTTP handler
 * ```typescript
 * export const mailer = defineMailer({ domain: "myapp.com" });
 *
 * export const signup = defineHttp({
 *   method: "POST",
 *   path: "/signup",
 *   deps: { mailer },
 *   onRequest: async ({ req, deps }) => {
 *     await deps.mailer.send({
 *       from: "hello@myapp.com",
 *       to: req.body.email,
 *       subject: "Welcome!",
 *       html: "<h1>Hi!</h1>",
 *     });
 *     return { status: 200, body: { ok: true } };
 *   },
 * });
 * ```
 */
export const defineMailer = (options: MailerConfig): MailerHandler => ({
  __brand: "effortless-mailer",
  __spec: options,
});

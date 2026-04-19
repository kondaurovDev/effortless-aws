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
 * @see {@link https://effortless-aws.website/use-cases/email | Email guide}
 */
export const defineMailer = () => (options: MailerConfig): MailerHandler => ({
  __brand: "effortless-mailer",
  __spec: options,
});

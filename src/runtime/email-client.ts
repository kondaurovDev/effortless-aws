import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * Options for sending an email via EmailClient.send()
 */
type SendEmailBase = {
  /** Sender address (must be on a verified domain) */
  from: string;
  /** Recipient address(es) */
  to: string | string[];
  /** Email subject line */
  subject: string;
};

export type SendEmailOptions = SendEmailBase & (
  | { html: string; text?: string }
  | { html?: string; text: string }
);

/**
 * Typed SES email client injected via deps.
 *
 * Lazily initializes the SESv2 SDK client on first use (cold start friendly).
 * Uses the AWS_REGION environment variable set by the Lambda runtime.
 */
export type EmailClient = {
  /** Send an email via SES */
  send(opts: SendEmailOptions): Promise<void>;
};

/**
 * Creates an EmailClient that sends emails via Amazon SESv2.
 * Lazily initializes the SESv2 SDK client on first use.
 */
export const createEmailClient = (): EmailClient => {
  let client: SESv2Client | null = null;
  const getClient = () => (client ??= new SESv2Client({}));

  return {
    async send({ from, to, subject, html, text }) {
      const toAddresses = Array.isArray(to) ? to : [to];
      await getClient().send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: toAddresses },
          Content: {
            Simple: {
              Subject: { Data: subject },
              Body: {
                ...(html ? { Html: { Data: html } } : {}),
                ...(text ? { Text: { Data: text } } : {}),
              },
            },
          },
        })
      );
    },
  };
};

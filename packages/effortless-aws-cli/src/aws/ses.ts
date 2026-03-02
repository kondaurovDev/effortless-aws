import { Effect } from "effect";
import { sesv2 } from "./clients";

export type EnsureSesIdentityInput = {
  domain: string;
  tags?: Record<string, string>;
};

export type DkimRecord = {
  name: string;
  value: string;
};

export type EnsureSesIdentityResult = {
  domain: string;
  verified: boolean;
  dkimRecords: DkimRecord[];
};

/**
 * Ensure an SES email identity exists for the given domain.
 * Creates the identity if it doesn't exist, returns DKIM records and verification status.
 */
export const ensureSesIdentity = (input: EnsureSesIdentityInput) =>
  Effect.gen(function* () {
    const { domain, tags } = input;

    // Check if identity already exists
    const existing = yield* sesv2.make("get_email_identity", {
      EmailIdentity: domain,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof sesv2.SESv2Error && error.is("NotFoundException"),
        () => Effect.succeed(undefined)
      )
    );

    if (!existing) {
      yield* Effect.logDebug(`Creating SES email identity for ${domain}...`);
      yield* sesv2.make("create_email_identity", {
        EmailIdentity: domain,
        DkimSigningAttributes: {
          NextSigningKeyLength: "RSA_2048_BIT",
        },
        ...(tags ? { Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) } : {}),
      });

      // Re-fetch to get DKIM tokens
      const created = yield* sesv2.make("get_email_identity", {
        EmailIdentity: domain,
      });

      const dkimRecords = (created.DkimAttributes?.Tokens ?? []).map((token) => ({
        name: `${token}._domainkey.${domain}`,
        value: `${token}.dkim.amazonses.com`,
      }));

      return {
        domain,
        verified: false,
        dkimRecords,
      };
    }

    // Identity exists — check verification status and return DKIM records
    const verified = existing.DkimAttributes?.Status === "SUCCESS";
    const dkimRecords = (existing.DkimAttributes?.Tokens ?? []).map((token) => ({
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com`,
    }));

    return {
      domain,
      verified,
      dkimRecords,
    };
  });

/**
 * Delete an SES email identity.
 */
export const deleteSesIdentity = (domain: string) =>
  Effect.gen(function* () {
    yield* sesv2.make("delete_email_identity", {
      EmailIdentity: domain,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof sesv2.SESv2Error && error.is("NotFoundException"),
        () => Effect.void
      )
    );
  });

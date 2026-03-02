import { Effect } from "effect";
import { acm } from "./clients";

export type FindCertificateResult = {
  certificateArn: string;
  coveredDomains: string[];
};

const getWildcard = (domain: string): string => {
  const parts = domain.split(".");
  if (parts.length < 2) return domain;
  return `*.${parts.slice(1).join(".")}`;
};

const domainCoveredBy = (domain: string, coveredDomains: string[]): boolean =>
  coveredDomains.includes(domain) || coveredDomains.includes(getWildcard(domain));

/**
 * Find an issued ACM certificate that covers the specified domain.
 * Checks both exact domain matches and wildcard certificates (*.domain.com).
 * ACM must be queried in us-east-1 for CloudFront usage.
 */
export const findCertificate = (domain: string) =>
  Effect.gen(function* () {
    let nextToken: string | undefined;

    do {
      const result = yield* acm.make("list_certificates", {
        CertificateStatuses: ["ISSUED"],
        ...(nextToken ? { NextToken: nextToken } : {}),
      });

      for (const cert of result.CertificateSummaryList ?? []) {
        if (!cert.CertificateArn) continue;

        const coveredDomains = cert.SubjectAlternativeNameSummaries ?? [];
        if (coveredDomains.length === 0 && cert.DomainName) {
          coveredDomains.push(cert.DomainName);
        }

        if (domainCoveredBy(domain, coveredDomains)) {
          yield* Effect.logDebug(`Found ACM certificate: ${cert.CertificateArn} covering ${domain}`);
          return { certificateArn: cert.CertificateArn, coveredDomains } satisfies FindCertificateResult;
        }
      }

      nextToken = result.NextToken;
    } while (nextToken);

    return yield* Effect.fail(
      new Error(
        `No issued ACM certificate found in us-east-1 covering "${domain}". ` +
        `Create a certificate in AWS Certificate Manager (us-east-1 region) for your domain, ` +
        `then validate it via DNS before deploying.`
      )
    );
  });

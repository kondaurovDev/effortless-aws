import { Effect, Console } from "effect";
import type { ExtractedMailerFunction } from "~/build/bundle";
import {
  ensureSesIdentity,
  type DkimRecord,
  makeTags,
  resolveStage,
  type TagContext,
} from "../aws";
import { c } from "~/cli/colors";

export type DeployMailerResult = {
  exportName: string;
  domain: string;
  verified: boolean;
  dkimRecords: DkimRecord[];
};

type DeployMailerInput = {
  project: string;
  stage?: string;
  region: string;
  fn: ExtractedMailerFunction;
};

/** @internal */
export const deployMailer = ({ project, stage, region, fn }: DeployMailerInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = exportName;
    const resolvedStage = resolveStage(stage);

    const tagCtx: TagContext = {
      project,
      stage: resolvedStage,
      handler: handlerName,
    };

    yield* Effect.logDebug(`Ensuring SES identity for ${config.domain}...`);
    const { domain, verified, dkimRecords } = yield* ensureSesIdentity({
      domain: config.domain,
      tags: makeTags(tagCtx, "ses"),
    });

    if (!verified && dkimRecords.length > 0) {
      yield* Console.log(`\n  ${c.yellow("⚠")} Domain ${c.cyan(domain)} is not verified. Add these DNS records:\n`);
      for (const record of dkimRecords) {
        yield* Console.log(`    ${c.dim("CNAME")} ${record.name}`);
        yield* Console.log(`    ${c.dim("→")}     ${record.value}\n`);
      }
    }

    return {
      exportName,
      domain,
      verified,
      dkimRecords,
    };
  });

import { Effect, Console } from "effect";
import type { ExtractedMailerFunction } from "~/discovery";
import { ensureSesIdentity, type DkimRecord } from "../aws";
import { makeTags, type TagContext } from "../core";
import { DeployContext } from "../core";
import { c } from "~/cli/colors";

export type DeployMailerResult = {
  exportName: string;
  domain: string;
  verified: boolean;
  dkimRecords: DkimRecord[];
};

type DeployMailerInput = {
  fn: ExtractedMailerFunction;
};

/** @internal */
export const deployMailer = ({ fn }: DeployMailerInput) =>
  Effect.gen(function* () {
    const { project, stage } = yield* DeployContext;
    const { exportName, config } = fn;
    const handlerName = exportName;

    const tagCtx: TagContext = {
      project,
      stage,
      handler: handlerName,
    };

    yield* Effect.logDebug(`Ensuring SES identity for ${config.domain}...`);
    const { domain, verified, dkimRecords } = yield* ensureSesIdentity({
      domain: config.domain,
      tags: makeTags(tagCtx),
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

import { Effect } from "effect";
import { EC2Client, DescribeSubnetsCommand, DescribeVpcsCommand } from "@aws-sdk/client-ec2";

/**
 * Discover default VPC subnets for Fargate tasks.
 * Uses the default VPC — no VPC configuration needed from the user.
 */
export const getDefaultVpcSubnets = (region: string) =>
  Effect.gen(function* () {
    const ec2 = new EC2Client({ region });

    // Find default VPC
    const vpcs = yield* Effect.tryPromise(() =>
      ec2.send(new DescribeVpcsCommand({
        Filters: [{ Name: "isDefault", Values: ["true"] }],
      }))
    );

    const vpcId = vpcs.Vpcs?.[0]?.VpcId;
    if (!vpcId) {
      return yield* Effect.fail(new Error(
        "No default VPC found. Fargate workers require a VPC with subnets. " +
        "Create a default VPC with: aws ec2 create-default-vpc"
      ));
    }

    // Get subnets in the default VPC
    const subnets = yield* Effect.tryPromise(() =>
      ec2.send(new DescribeSubnetsCommand({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      }))
    );

    const subnetIds = subnets.Subnets?.map(s => s.SubnetId!).filter(Boolean) ?? [];
    if (subnetIds.length === 0) {
      return yield* Effect.fail(new Error(
        `Default VPC ${vpcId} has no subnets. Create default subnets with: aws ec2 create-default-subnet`
      ));
    }

    yield* Effect.logDebug(`Found ${subnetIds.length} subnets in default VPC ${vpcId}`);
    return subnetIds;
  });

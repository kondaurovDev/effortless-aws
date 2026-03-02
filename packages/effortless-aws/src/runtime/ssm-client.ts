import { SSM } from "@aws-sdk/client-ssm";

let client: SSM | null = null;
const getClient = () => (client ??= new SSM({}));

/**
 * Batch-fetch SSM parameters with automatic chunking.
 * SSM GetParameters supports max 10 names per call.
 * All values are fetched with decryption enabled (SecureString support).
 */
export const getParameters = async (names: string[]): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  for (let i = 0; i < names.length; i += 10) {
    const batch = names.slice(i, i + 10);
    const result = await getClient().getParameters({
      Names: batch,
      WithDecryption: true,
    });
    for (const p of result.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) {
        map.set(p.Name, p.Value);
      }
    }
  }
  return map;
};

import { describe, it, expect } from "vitest"
import { resolveSecrets } from "~cli/deploy/shared"

describe("resolveSecrets", () => {
  it("returns undefined when secretEntries is empty", () => {
    const result = resolveSecrets([], "my-app", "prod");
    expect(result).toBeUndefined();
  });

  it("maps secret entries to EFF_PARAM_* env vars with SSM path convention", () => {
    const result = resolveSecrets(
      [
        { propName: "dbUrl", ssmKey: "db-url" },
        { propName: "apiKey", ssmKey: "api-key" },
      ],
      "my-app",
      "prod",
    );

    expect(result).toBeDefined();
    expect(result!.paramsEnv).toEqual({
      EFF_PARAM_dbUrl: "/my-app/prod/db-url",
      EFF_PARAM_apiKey: "/my-app/prod/api-key",
    });
  });

  it("returns SSM permissions", () => {
    const result = resolveSecrets(
      [{ propName: "secret", ssmKey: "my-secret" }],
      "app",
      "dev",
    );

    expect(result).toBeDefined();
    expect(result!.paramsPermissions).toContain("ssm:GetParameter");
    expect(result!.paramsPermissions).toContain("ssm:GetParameters");
  });

  it("uses the correct SSM path format: /{project}/{stage}/{ssmKey}", () => {
    const result = resolveSecrets(
      [{ propName: "token", ssmKey: "auth-token" }],
      "project-x",
      "staging",
    );

    expect(result!.paramsEnv["EFF_PARAM_token"]).toBe("/project-x/staging/auth-token");
  });

  it("handles a single secret entry", () => {
    const result = resolveSecrets(
      [{ propName: "key", ssmKey: "encryption-key" }],
      "svc",
      "dev",
    );

    expect(result).toBeDefined();
    expect(Object.keys(result!.paramsEnv)).toHaveLength(1);
    expect(result!.paramsEnv["EFF_PARAM_key"]).toBe("/svc/dev/encryption-key");
  });

  it("returns a mutable permissions array", () => {
    const result = resolveSecrets(
      [{ propName: "a", ssmKey: "a" }],
      "p",
      "s",
    );

    // The permissions array should be a regular array (not a readonly tuple from the const assertion)
    expect(Array.isArray(result!.paramsPermissions)).toBe(true);
  });
});

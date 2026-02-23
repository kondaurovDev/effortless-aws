import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"

// Mock SESv2 client before importing anything
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send = mockSend;
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Mock DynamoDB (needed because handler-utils imports table-client)
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: class {},
}));

// Mock S3 (needed because handler-utils imports bucket-client)
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  PutObjectCommand: class {},
  GetObjectCommand: class {},
  DeleteObjectCommand: class {},
  ListObjectsV2Command: class {},
}));

import { createEmailClient } from "~/runtime/email-client"
import { wrapHttp } from "~/runtime/wrap-http"
import type { HttpHandler } from "~/handlers/define-http"
import { defineMailer } from "~/handlers/define-mailer"

const makeHttpEvent = (overrides: Record<string, unknown> = {}) => ({
  requestContext: { http: { method: "POST", path: "/test" } },
  headers: {},
  queryStringParameters: {},
  pathParameters: {},
  body: undefined as string | undefined,
  ...overrides,
});

describe("EmailClient", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it("should send email with html body", async () => {
    const client = createEmailClient();

    await client.send({
      from: "hello@myapp.com",
      to: "user@example.com",
      subject: "Welcome",
      html: "<h1>Hi!</h1>",
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const cmd = mockSend.mock.calls[0]![0];
    expect(cmd.input).toEqual({
      FromEmailAddress: "hello@myapp.com",
      Destination: { ToAddresses: ["user@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Welcome" },
          Body: { Html: { Data: "<h1>Hi!</h1>" } },
        },
      },
    });
  });

  it("should send email with text body", async () => {
    const client = createEmailClient();

    await client.send({
      from: "hello@myapp.com",
      to: "user@example.com",
      subject: "Welcome",
      text: "Hi!",
    });

    const cmd = mockSend.mock.calls[0]![0];
    expect(cmd.input.Content.Simple.Body).toEqual({ Text: { Data: "Hi!" } });
  });

  it("should send email with both html and text", async () => {
    const client = createEmailClient();

    await client.send({
      from: "hello@myapp.com",
      to: "user@example.com",
      subject: "Welcome",
      html: "<h1>Hi!</h1>",
      text: "Hi!",
    });

    const cmd = mockSend.mock.calls[0]![0];
    expect(cmd.input.Content.Simple.Body).toEqual({
      Html: { Data: "<h1>Hi!</h1>" },
      Text: { Data: "Hi!" },
    });
  });

  it("should accept multiple recipients", async () => {
    const client = createEmailClient();

    await client.send({
      from: "hello@myapp.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Hello",
      html: "<p>Hi all</p>",
    });

    const cmd = mockSend.mock.calls[0]![0];
    expect(cmd.input.Destination.ToAddresses).toEqual(["a@example.com", "b@example.com"]);
  });

  it("should lazily initialize SES client (only on first send)", async () => {
    const client = createEmailClient();
    expect(mockSend).not.toHaveBeenCalled();

    await client.send({ from: "a@x.com", to: "b@x.com", subject: "test", text: "hi" });
    await client.send({ from: "a@x.com", to: "c@x.com", subject: "test2", text: "hi2" });

    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe("defineMailer", () => {

  it("should return a branded handler with config", () => {
    const mailer = defineMailer({ domain: "myapp.com" });

    expect(mailer.__brand).toBe("effortless-mailer");
    expect(mailer.__spec).toEqual({ domain: "myapp.com" });
  });
});

describe("mailer as dep in HTTP handler", () => {

  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should inject EmailClient via deps.mailer", async () => {
    process.env = { ...originalEnv, EFF_DEP_mailer: "mailer:myapp.com" };

    let capturedDeps: any = null;

    const handler = {
      __brand: "effortless-http",
      __spec: { method: "POST", path: "/send" },
      deps: { mailer: { __brand: "effortless-mailer", __spec: { domain: "myapp.com" } } },
      onRequest: async (args: any) => {
        capturedDeps = args.deps;
        await args.deps.mailer.send({
          from: "hello@myapp.com",
          to: "user@test.com",
          subject: "Hi",
          html: "<h1>Hello</h1>",
        });
        return { status: 200, body: { ok: true } };
      },
    } as unknown as HttpHandler<undefined, undefined, any>;

    const wrapped = wrapHttp(handler);
    const response = await wrapped(makeHttpEvent());

    expect(response.statusCode).toBe(200);
    expect(capturedDeps.mailer).toBeDefined();
    expect(typeof capturedDeps.mailer.send).toBe("function");
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("should work alongside table deps", async () => {
    process.env = {
      ...originalEnv,
      EFF_DEP_mailer: "mailer:myapp.com",
      EFF_DEP_orders: "table:my-project-dev-orders",
    };

    let capturedDeps: any = null;

    const handler = {
      __brand: "effortless-http",
      __spec: { method: "POST", path: "/send" },
      deps: {
        mailer: { __brand: "effortless-mailer", __spec: { domain: "myapp.com" } },
        orders: { __brand: "effortless-table", config: {} },
      },
      onRequest: async (args: any) => {
        capturedDeps = args.deps;
        return { status: 200, body: { ok: true } };
      },
    } as unknown as HttpHandler<undefined, undefined, any>;

    const wrapped = wrapHttp(handler);
    await wrapped(makeHttpEvent());

    expect(capturedDeps.mailer).toBeDefined();
    expect(typeof capturedDeps.mailer.send).toBe("function");
    expect(capturedDeps.orders).toBeDefined();
    expect(capturedDeps.orders.tableName).toBe("my-project-dev-orders");
  });
});

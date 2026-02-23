---
title: Email
description: Send transactional emails with defineMailer — SES domain verification, DKIM setup, typed EmailClient, and zero-config IAM.
---

You need to send emails from your serverless app — welcome messages, password resets, order confirmations, notifications. [Amazon SES](https://aws.amazon.com/ses/) is the standard choice, but setting up domain verification, DKIM records, IAM permissions, and SDK clients is tedious boilerplate.

With `defineMailer` you declare the domain once, and get a typed `EmailClient` injected into any handler via `deps` — with automatic IAM wiring and DKIM setup.

## Setting up a mailer

Define a mailer with your sending domain:

```typescript
// src/mailer.ts
import { defineMailer } from "effortless-aws";

export const mailer = defineMailer({ domain: "myapp.com" });
```

On first deploy, Effortless creates an SES email identity and prints DKIM DNS records to the console:

```
⚠ Domain myapp.com is not verified. Add these DNS records:

    CNAME abc123._domainkey.myapp.com
    →     abc123.dkim.amazonses.com

    CNAME def456._domainkey.myapp.com
    →     def456.dkim.amazonses.com

    CNAME ghi789._domainkey.myapp.com
    →     ghi789.dkim.amazonses.com
```

Add these CNAME records to your DNS provider. Once DNS propagates, SES verifies your domain automatically. Subsequent deploys detect that the domain is already verified and skip this step.

## Sending emails

Import the mailer into any handler and add it to `deps`. The framework injects a typed `EmailClient`:

```typescript
// src/api.ts
import { defineHttp } from "effortless-aws";
import { mailer } from "./mailer";

export const signup = defineHttp({
  method: "POST",
  path: "/signup",
  deps: { mailer },
  onRequest: async ({ req, deps }) => {
    // ... create user ...

    await deps.mailer.send({
      from: "hello@myapp.com",
      to: req.body.email,
      subject: "Welcome to MyApp!",
      html: "<h1>Welcome!</h1><p>Your account is ready.</p>",
    });

    return { status: 201, body: { created: true } };
  },
});
```

`deps.mailer` is an `EmailClient` — the Lambda automatically gets `ses:SendEmail` and `ses:SendRawEmail` IAM permissions.

## HTML and plain text

You must provide at least one of `html` or `text`. Providing both is recommended for maximum email client compatibility:

```typescript
await deps.mailer.send({
  from: "hello@myapp.com",
  to: "user@example.com",
  subject: "Your order has shipped",
  html: "<h1>Order Shipped</h1><p>Track it at...</p>",
  text: "Order Shipped\n\nTrack it at...",
});
```

If you only provide `text`, the email is sent as plain text. If you only provide `html`, email clients without HTML support will show the raw HTML. TypeScript enforces that at least one is present at compile time.

## Multiple recipients

Pass an array to `to` for multiple recipients:

```typescript
await deps.mailer.send({
  from: "team@myapp.com",
  to: ["alice@example.com", "bob@example.com", "carol@example.com"],
  subject: "Team update",
  text: "New release is out!",
});
```

## Using with other deps

Mailers compose with tables, buckets, and queues — just add them all to `deps`:

```typescript
import { defineHttp, defineTable, typed } from "effortless-aws";
import { mailer } from "./mailer";

type User = { tag: string; name: string; email: string };

export const users = defineTable({
  schema: typed<User>(),
});

export const invite = defineHttp({
  method: "POST",
  path: "/invite/{userId}",
  deps: { users, mailer },
  onRequest: async ({ req, deps }) => {
    const user = await deps.users.get({
      pk: `USER#${req.params.userId}`,
      sk: "PROFILE",
    });
    if (!user) return { status: 404, body: { error: "User not found" } };

    await deps.mailer.send({
      from: "no-reply@myapp.com",
      to: user.data.email,
      subject: "You're invited!",
      html: `<p>Hi ${user.data.name}, you've been invited to join the project.</p>`,
    });

    return { status: 200, body: { sent: true } };
  },
});
```

Each Lambda gets only the permissions it needs — DynamoDB for the table, SES for sending email.

## Sending from a queue processor

Email sending works from any handler type. Use a FIFO queue for reliable, ordered email delivery:

```typescript
import { defineFifoQueue, typed } from "effortless-aws";
import { mailer } from "./mailer";

type EmailJob = { to: string; subject: string; html: string };

export const emailQueue = defineFifoQueue({
  schema: typed<EmailJob>(),
  deps: { mailer },
  onMessage: async ({ message, deps }) => {
    await deps.mailer.send({
      from: "no-reply@myapp.com",
      to: message.body.to,
      subject: message.body.subject,
      html: message.body.html,
    });
  },
});
```

If SES returns an error, the message stays in the queue and is retried automatically.

## Sending from a table stream

React to database changes and send emails:

```typescript
import { defineTable, typed } from "effortless-aws";
import { mailer } from "./mailer";

type Order = { tag: string; email: string; amount: number; status: string };

export const orders = defineTable({
  schema: typed<Order>(),
  deps: { mailer },
  onRecord: async ({ record, deps }) => {
    if (record.eventName === "INSERT" && record.new) {
      await deps.mailer.send({
        from: "orders@myapp.com",
        to: record.new.data.email,
        subject: "Order confirmed",
        html: `<p>Your order of $${record.new.data.amount} has been confirmed.</p>`,
      });
    }
  },
});
```

## Using with templates

Combine `defineMailer` with `static` files to use email templates:

```typescript
import { defineHttp } from "effortless-aws";
import { mailer } from "./mailer";

export const sendInvoice = defineHttp({
  method: "POST",
  path: "/send-invoice",
  deps: { mailer },
  static: ["src/templates/invoice.html"],
  onRequest: async ({ req, deps, files }) => {
    const template = files.read("src/templates/invoice.html");
    const html = template
      .replace("{{name}}", req.body.name)
      .replace("{{amount}}", req.body.amount);

    await deps.mailer.send({
      from: "billing@myapp.com",
      to: req.body.email,
      subject: "Your invoice",
      html,
    });

    return { status: 200, body: { sent: true } };
  },
});
```

## See also

- [Definitions reference — defineMailer](/definitions/#definemailer) — configuration options and EmailClient API
- [Storage guide](/use-cases/storage/) — how to define S3 buckets
- [Database guide](/use-cases/database/) — how to define tables and use them as deps
- [Queue guide](/use-cases/queue/) — how to define FIFO queues

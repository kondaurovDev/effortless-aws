---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

Add automatic dead-letter queue (DLQ) for FIFO queues. A `*-dlq.fifo` queue is now created alongside every FIFO queue with a configurable `maxReceiveCount` (default: 3).

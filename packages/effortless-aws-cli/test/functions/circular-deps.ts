import { defineTable, defineFifoQueue, unsafeAs } from "effortless-aws";
import type { FifoQueueHandler } from "effortless-aws";

type Task = { id: string; status: string; payload: string };
type TaskMessage = { taskId: string; action: string };

// unsafeAs enables T inference alongside deps inference
export const tasks = defineTable({
  schema: unsafeAs<Task>(),
  deps: () => ({ taskQueue }),
  onRecord: async ({ record, deps }) => {
    if (record.eventName === "INSERT" && record.new?.data) {
      await deps.taskQueue.send({
        body: { taskId: record.new.data.id, action: "process" },
        groupId: record.new.data.id,
      });
    }
  },
});

// Annotation on one handler breaks circular inference
export const taskQueue: FifoQueueHandler = defineFifoQueue({
  schema: unsafeAs<TaskMessage>(),
  deps: () => ({ tasks }),
  onMessage: async ({ message, deps }) => {
    const item = await deps.tasks.get({ pk: message.body.taskId, sk: "task" });
    console.log("Processing task:", item?.data?.status);
  },
});

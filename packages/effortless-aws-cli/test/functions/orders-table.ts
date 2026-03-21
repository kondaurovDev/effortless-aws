import { defineTable } from "effortless-aws";

type Order = {
  id: string;
  amount: number;
  status: string;
  customerId: string;
};

type Customer = { customerId: string; email: string; tier: string };

// Dep: customers table (resource-only)
export const customers = defineTable<Customer>().build();

// Simulated external service
const analyticsService = {
  async send(event: { type: string; orderId: string }): Promise<void> {
    console.log(`[Analytics] Sending event: ${event.type} for ${event.orderId}`);
  }
};

const notificationService = {
  async notifyHighValueOrder(order: Order): Promise<void> {
    console.log(`[Notification] High-value order alert: ${order.id} for $${order.amount}`);
  },
  async notifyChurn(customerId: string, lostRevenue: number): Promise<void> {
    console.log(`[Notification] Potential churn: customer ${customerId}, lost $${lostRevenue}`);
  }
};

export const orders = defineTable<Order>({
  streamView: "NEW_AND_OLD_IMAGES",
  batchSize: 10,
  memory: 256,
})
  .deps(() => ({ customers }))
  .config(({ defineSecret }) => ({
    highValueThreshold: defineSecret<number>({ key: "high-value-threshold", transform: Number }),
  }))
  .setup(({ deps, config }) => ({
    highValueThreshold: config.highValueThreshold,
    customers: deps.customers,
  }))
  .onRecord(async ({ record, highValueThreshold, customers }) => {
    const { eventName } = record;
    const newOrder = record.new?.data;
    const oldOrder = record.old?.data;

    if (eventName === "INSERT" && newOrder) {
      if (newOrder.amount > highValueThreshold) {
        await notificationService.notifyHighValueOrder(newOrder);
      }
      await analyticsService.send({ type: "order_created", orderId: newOrder.id });
    }

    if (eventName === "MODIFY" && oldOrder && newOrder) {
      if (oldOrder.status !== newOrder.status) {
        await analyticsService.send({ type: "order_updated", orderId: newOrder.id });
      }
    }

    if (eventName === "REMOVE" && oldOrder) {
      if (oldOrder.status !== "completed") {
        await notificationService.notifyChurn(oldOrder.customerId, oldOrder.amount);
        await analyticsService.send({ type: "order_cancelled", orderId: oldOrder.id });
      }
    }
  });

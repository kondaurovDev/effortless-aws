import { defineTable } from "../../src/handlers/define-table";

type Order = {
  id: string;
  amount: number;
  status: string;
  customerId: string;
};

// Event types for analytics
type OrderEvent =
  | { type: "order_created"; orderId: string; amount: number; customerId: string }
  | { type: "order_updated"; orderId: string; oldStatus: string; newStatus: string; amountDelta: number }
  | { type: "order_cancelled"; orderId: string; lostRevenue: number; customerId: string };

// Simulated external service
const analyticsService = {
  async sendBatch(events: OrderEvent[]): Promise<void> {
    // In real world: fetch("https://analytics.example.com/events", { method: "POST", body: JSON.stringify(events) })
    console.log(`[Analytics] Sending ${events.length} events to analytics service`);
    console.log(JSON.stringify(events, null, 2));
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

export const orders = defineTable<Order, undefined, OrderEvent | null>({
  name: "test-orders",
  pk: { name: "id", type: "string" },
  streamView: "NEW_AND_OLD_IMAGES",
  batchSize: 10,
  memory: 256,

  onRecord: async ({ record }): Promise<OrderEvent | null> => {
    const { eventName, old: oldOrder, new: newOrder } = record;

    if (eventName === "INSERT" && newOrder) {
      // New order - track creation event
      if (newOrder.amount > 1000) {
        await notificationService.notifyHighValueOrder(newOrder);
      }

      return {
        type: "order_created",
        orderId: newOrder.id,
        amount: newOrder.amount,
        customerId: newOrder.customerId
      };
    }

    if (eventName === "MODIFY" && oldOrder && newOrder) {
      // Order updated - track status changes and amount adjustments
      const amountDelta = newOrder.amount - oldOrder.amount;

      if (oldOrder.status !== newOrder.status || amountDelta !== 0) {
        return {
          type: "order_updated",
          orderId: newOrder.id,
          oldStatus: oldOrder.status,
          newStatus: newOrder.status,
          amountDelta
        };
      }
    }

    if (eventName === "REMOVE" && oldOrder) {
      // Order deleted - potential cancellation
      if (oldOrder.status !== "completed") {
        await notificationService.notifyChurn(oldOrder.customerId, oldOrder.amount);

        return {
          type: "order_cancelled",
          orderId: oldOrder.id,
          lostRevenue: oldOrder.amount,
          customerId: oldOrder.customerId
        };
      }
    }

    return null;
  },

  onBatchComplete: async ({ results, failures }) => {
    // Filter out nulls and send accumulated events
    const events = results.filter((e): e is OrderEvent => e !== null);

    if (events.length > 0) {
      await analyticsService.sendBatch(events);

      // Calculate batch statistics
      const stats = {
        created: events.filter(e => e.type === "order_created").length,
        updated: events.filter(e => e.type === "order_updated").length,
        cancelled: events.filter(e => e.type === "order_cancelled").length,
        totalRevenue: events
          .filter((e): e is Extract<OrderEvent, { type: "order_created" }> => e.type === "order_created")
          .reduce((sum, e) => sum + e.amount, 0),
        lostRevenue: events
          .filter((e): e is Extract<OrderEvent, { type: "order_cancelled" }> => e.type === "order_cancelled")
          .reduce((sum, e) => sum + e.lostRevenue, 0)
      };

      console.log(`[Batch Stats] Created: ${stats.created}, Updated: ${stats.updated}, Cancelled: ${stats.cancelled}`);
      console.log(`[Batch Stats] Revenue: +$${stats.totalRevenue}, Lost: -$${stats.lostRevenue}`);
    }

    if (failures.length > 0) {
      console.error(`[Batch] ${failures.length} records failed to process`);
      // Could send to DLQ or alert here
    }
  }
});

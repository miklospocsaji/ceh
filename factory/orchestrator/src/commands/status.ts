/**
 * `/status` (add-owner-commands design, "/status"): where the work item stands, from the ledger
 * only. No Step Functions call, so it answers the same in the cloud and locally.
 */
import { listAttempts, listTasks, workItemCost, type WorkItemRow } from "@ceh/factory-ledger";
import type { HandlerContext } from "../handler.ts";
import type { StatusFigures } from "./replies.ts";

/** The figures `/status` reports; undefined without a work item. */
export async function statusFigures(ctx: Pick<HandlerContext, "db">, workItem: WorkItemRow | undefined): Promise<StatusFigures | undefined> {
  if (workItem === undefined) return undefined;
  const [tasks, attempts, costUsd] = await Promise.all([listTasks(ctx.db, workItem.id), listAttempts(ctx.db, workItem.id), workItemCost(ctx.db, workItem.id)]);
  const pending = tasks.find((task) => task.status === "pending");
  const step =
    workItem.state !== "build" ? `\`${workItem.state}\`` : pending === undefined ? "every task is built" : `task ${pending.taskId}, ${pending.title}`;
  return {
    changeId: workItem.changeId,
    state: workItem.state,
    step,
    tasks: tasks.length === 0 ? undefined : { done: tasks.filter((task) => task.status === "done").length, total: tasks.length },
    attempts: attempts.length,
    costUsd,
  };
}


import type { CliConfig } from "../config.ts";

interface TaskListItem {
  task_id: string;
  status: string;
  prompt: string;
  ticket_count: number;
  running_count: number;
  waiting_count: number;
}

export async function runTasks(config: CliConfig, options: { limit?: number; json?: boolean } = {}): Promise<number> {
  const limit = options.limit ?? 20;
  try {
    const response = await fetch(`${config.orchestratorUrl}/v1/tasks?limit=${limit}`, {
      headers: { authorization: `Bearer ${config.routerToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`Orchestrator returned ${response.status}: ${await response.text()}`);
      return 1;
    }
    const body = await response.json() as { tasks: TaskListItem[] };
    if (options.json) {
      console.log(JSON.stringify(body, null, 2));
      return 0;
    }
    if (body.tasks.length === 0) {
      console.log("No tasks.");
      return 0;
    }
    console.log(["TASK", "STATUS", "TICKETS", "RUN", "WAIT", "PROMPT"].join("\t"));
    for (const task of body.tasks) {
      console.log([
        task.task_id,
        task.status,
        String(task.ticket_count),
        String(task.running_count),
        String(task.waiting_count),
        task.prompt.slice(0, 60).replaceAll("\n", " "),
      ].join("\t"));
    }
    return 0;
  } catch (error) {
    console.error(`Cannot reach Orchestrator at ${config.orchestratorUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

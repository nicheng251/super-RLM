import {
  CombinedAutocompleteProvider,
  Editor,
  HStack,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  type EditorTheme,
  type StackChild,
} from "@earendil-works/pi-tui";
import { RpcClient, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { buildRouterArgs, routerEnv, type CliConfig } from "../../cli/src/config.ts";
import { TaskDetailPageModel, TasksPageModel } from "../../router/src/page-model.ts";
import type { TaskListItem, TicketSummary } from "../../../packages/protocol/ts/index.ts";
import { TuiApi } from "./api.ts";
import { OrchestratorEventStream } from "./event-stream.ts";
import { COMMAND_HELP, COMMANDS, parseSlashCommand } from "./commands.ts";
import { mapKey, type Action, type FocusArea } from "./keymap.ts";
import {
  addEvent,
  clamp,
  createState,
  filterTasks,
  formatEventLine,
  nextTaskFilter,
  setView,
  waitingTaskCount,
  type AppState,
  type TaskFilter,
  type ViewName,
} from "./state.ts";
import { AnswerDialog } from "./ui/answer-dialog.ts";
import {
  ChatPane,
  Footer,
  LinesPane,
  SidebarPane,
  StatusBar,
  type ChatLine,
  type SidebarModel,
  type StatusModel,
} from "./ui/panes.ts";
import { bold, cyan, dim, gray, green, red, yellow } from "./ui/theme.ts";

const FOOTER_HELP: Record<ViewName, string> = {
  chat: "Enter send/steer \u00b7 / commands \u00b7 Alt+1..4 views \u00b7 ^C exit",
  tasks: "j/k select \u00b7 Enter detail \u00b7 f filter \u00b7 r refresh \u00b7 Alt+1 chat",
  detail: "j/k ticket \u00b7 a answer \u00b7 s resume \u00b7 t retry \u00b7 c cancel \u00b7 r refresh \u00b7 Alt+2 tasks",
  workers: "j/k scroll \u00b7 r refresh \u00b7 Alt+1 chat",
  events: "j/k scroll \u00b7 r refresh \u00b7 Alt+1 chat",
};

const EDITOR_THEME: EditorTheme = {
  borderColor: gray,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: gray,
    scrollInfo: dim,
    noMatch: dim,
  },
};

export class TuiApp {
  readonly state: AppState = createState();
  private readonly tui: TuiAltScreen;
  private readonly api: TuiApi;
  private readonly tasksModel: TasksPageModel;
  private detailModel: TaskDetailPageModel | null = null;
  private readonly editor: Editor;
  private readonly sidebar: SidebarPane;
  private readonly statusBar: StatusBar;
  private readonly footer = new Footer();
  private readonly chatPane = new ChatPane();
  private readonly tasksPane = new LinesPane();
  private readonly detailPane = new LinesPane();
  private readonly workersPane = new LinesPane();
  private readonly eventsPane = new LinesPane();

  private readonly chatLines: ChatLine[] = [];
  private focus: FocusArea = "editor";
  private mainScroll: ScrollView | null = null;
  private stream: OrchestratorEventStream | null = null;
  private rpc: RpcClient | null = null;
  private piRunning = false;
  private assistantOpen = false;
  private piStderr = "";
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private taskTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private shuttingDown = false;
  private readonly originalStderrWrite = process.stderr.write.bind(process.stderr);
  private readonly config: CliConfig;

  constructor(config: CliConfig) {
    this.config = config;
    this.tui = new TuiAltScreen(new ProcessTerminal());
    this.editor = new Editor(this.tui, EDITOR_THEME, { paddingX: 1 });
    this.api = new TuiApi({
      baseUrl: config.orchestratorUrl,
      token: config.routerToken,
      workerPort: config.workerPort,
    });
    this.tasksModel = new TasksPageModel(this.api.client);
    this.sidebar = new SidebarPane(
      () => this.sidebarModel(),
      (view) => this.openView(view),
    );
    this.statusBar = new StatusBar(() => this.statusModel());
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      COMMANDS.map((command) => ({ name: command.name, description: command.description })),
      process.cwd(),
    ));
    this.editor.onChange = (text) => {
      if (text.startsWith("/") && !text.includes(" ")) {
        this.footer.setTransient(`Commands: ${COMMANDS.slice(0, 6).map((command) => `/${command.name}`).join(" ")} ...`);
        this.tui.requestRender();
      }
    };
    this.editor.onSubmit = (text) => { void this.submitChat(text); };
  }

  async run(): Promise<void> {
    this.installStderrCapture();
    this.tui.addInputListener((data) => this.handleGlobalInput(data));
    this.tui.start();
    this.rebuildLayout();
    this.setFocus("editor");
    this.pushChat({ kind: "system", text: "Starting Pi Router session..." });
    this.refreshViews();
    this.tui.requestRender();

    this.healthTimer = setInterval(() => { void this.pollHealth(); }, 5000);
    this.taskTimer = setInterval(() => {
      if (this.state.view === "tasks" || this.state.view === "detail") void this.loadTasks();
      if (this.state.view === "workers") void this.loadWorkers();
    }, 5000);

    void this.pollHealth();
    void this.loadTasks();
    void this.loadWorkers();
    this.startEventStream();
    void this.startPi();

    await new Promise<void>(() => {});
  }

  private async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.taskTimer) clearInterval(this.taskTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.stream?.stop();
    process.stderr.write = this.originalStderrWrite;
    try { await this.rpc?.stop(); } catch { /* ignore */ }
    this.tui.stop();
    process.exit(code);
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    const action = mapKey(data, { view: this.state.view, focus: this.focus, piRunning: this.piRunning });
    if (!action) return undefined;
    void this.runAction(action);
    return { consume: true };
  }

  private async runAction(action: Action): Promise<void> {
    switch (action.kind) {
      case "exit":
        await this.shutdown(0);
        return;
      case "view":
        this.openView(action.view);
        return;
      case "move":
        if (this.state.view === "tasks") this.moveTask(action.delta);
        else if (this.state.view === "detail") this.detailModel?.move(action.delta);
        this.refreshViews();
        return;
      case "scroll":
        this.mainScroll?.scrollBy(action.delta);
        this.tui.requestRender();
        return;
      case "activate": {
        const task = this.tasksModel.selectedTask();
        if (task) this.openDetail(task.task_id);
        return;
      }
      case "answer": {
        const ticket = this.currentTicket();
        if (ticket?.question) this.showAnswerDialog(ticket);
        else this.flash("No waiting question on the selected ticket.");
        return;
      }
      case "resume": {
        const ticket = this.currentTicket();
        if (ticket) await this.ticketAction(ticket.ticket_id, "resume");
        return;
      }
      case "retry": {
        const ticket = this.currentTicket();
        if (ticket) await this.ticketAction(ticket.ticket_id, "retry");
        return;
      }
      case "cancel": {
        const ticket = this.currentTicket();
        if (ticket) await this.ticketAction(ticket.ticket_id, "cancel");
        return;
      }
      case "refresh":
        await this.refreshCurrent();
        return;
      case "cycle-filter":
        this.applyTaskFilter(nextTaskFilter(this.state.filter));
        return;
      case "abort":
        await this.abortTurn();
        return;
      case "command":
        this.openCommandMode();
        return;
    }
  }

  private openCommandMode(): void {
    if (this.state.view !== "chat") {
      this.flash("Alt+1 opens Chat; slash commands are entered there.");
      return;
    }
    this.editor.setText("/");
    this.setFocus("editor");
    this.flash("Command mode: type /help for commands");
  }

  private async runSlashCommand(input: string): Promise<void> {
    const command = parseSlashCommand(input);
    if (!command) return;
    if (command.name === "unknown") {
      this.pushChat({ kind: "error", text: `Unknown command: ${command.raw} · /help` });
      return;
    }
    if (command.name === "help") {
      this.pushChat({ kind: "system", text: "Commands:" });
      for (const line of COMMAND_HELP) this.pushChat({ kind: "system", text: `  ${line}` });
      return;
    }
    switch (command.name) {
      case "filter":
        this.applyTaskFilter(command.filter ?? nextTaskFilter(this.state.filter));
        return;
      case "search":
        this.applyTaskQuery(command.query);
        return;
      case "clear":
        this.clearTaskFilter();
        return;
      case "refresh":
        await this.refreshCurrent();
        return;
      case "abort":
        await this.abortTurn();
        return;
      case "quit":
        await this.shutdown(0);
        return;
      case "answer": {
        const ticket = this.currentTicket();
        if (ticket?.question) this.showAnswerDialog(ticket);
        else this.flash("No waiting question on the selected ticket.");
        return;
      }
    }
  }

  private openView(view: ViewName): void {
    setView(this.state, view);
    this.sidebar.syncToCurrent();
    this.rebuildLayout();
    this.setFocus(view === "chat" ? "editor" : "main");
    this.refreshViews();
    if (view === "tasks") void this.loadTasks();
    if (view === "workers") void this.loadWorkers();
    if (view === "detail") {
      const taskId = this.detailModel?.taskId ?? this.tasksModel.selectedTask()?.task_id;
      if (!taskId) {
        this.detailModel = null;
        this.renderDetail();
        return;
      }
      if (!this.detailModel || this.detailModel.taskId !== taskId) {
        this.detailModel = new TaskDetailPageModel(this.api.client, taskId);
      }
      void this.loadDetail();
    }
  }

  private setFocus(area: FocusArea): void {
    this.focus = area;
    if (this.focus === "editor") {
      this.tui.setFocus(this.editor);
    } else {
      this.tui.setFocus(null);
    }
    this.tui.requestRender();
  }

  private rebuildLayout(): void {
    this.mainScroll = null;
    const chat = this.state.view === "chat";
    const main = chat ? this.buildChatView() : this.buildMainScroll();
    // Content on the left; navigation/sidebar on the right.
    const body = new HStack([
      { component: main, basis: 0, grow: 1, minSize: 20 },
      { component: this.sidebar, basis: 26, shrink: 0, minSize: 20, maxSize: 32 },
    ], { gap: 1 });
    const root: StackChild[] = [
      { component: this.statusBar, basis: "auto", shrink: 0, minSize: 1, maxSize: 1 },
      { component: body, basis: 0, grow: 1, minSize: 3 },
    ];
    if (chat) {
      // Help line above the input so the editor spans the full bottom row.
      root.push({ component: this.footer, basis: "auto", shrink: 0, minSize: 1, maxSize: 1 });
      root.push({ component: this.editor, basis: "auto", shrink: 0, minSize: 1 });
    } else {
      root.push({ component: this.footer, basis: "auto", shrink: 0, minSize: 1, maxSize: 2 });
    }
    this.tui.setLayoutRoot(new VStack(root));
    this.updateFooter();
  }

  private buildChatView(): ScrollView {
    const scroll = new ScrollView(this.chatPane, { follow: "end", primary: true });
    this.mainScroll = scroll;
    return scroll;
  }

  private buildMainScroll(): ScrollView {
    const pane = this.paneFor(this.state.view);
    const scroll = new ScrollView(pane, {
      primary: true,
      follow: this.state.view === "events" ? "end" : "none",
      scrollbar: "auto",
    });
    this.mainScroll = scroll;
    return scroll;
  }

  private paneFor(view: ViewName): LinesPane {
    if (view === "detail") return this.detailPane;
    if (view === "workers") return this.workersPane;
    if (view === "events") return this.eventsPane;
    return this.tasksPane;
  }

  private sidebarModel(): SidebarModel {
    return {
      current: this.state.view === "detail" ? "tasks" : this.state.view,
      focused: false,
      tasksWaiting: waitingTaskCount(this.tasksModel.state.tasks),
      detailWaiting: this.detailModel?.state.task?.tickets.some((ticket) => ticket.status === "waiting") ?? false,
      workers: this.state.workers.length,
      unreadEvents: this.state.unreadEvents,
    };
  }

  private statusModel(): StatusModel {
    return {
      projectId: this.config.projectId,
      orchestrator: this.state.health.orchestrator,
      worker: this.state.health.worker,
      sse: this.state.health.sse,
      pi: this.state.health.pi,
    };
  }

  // ----- data -----------------------------------------------------------------

  private async pollHealth(): Promise<void> {
    const [orchestrator, worker] = await Promise.all([
      this.api.orchestratorHealthy(),
      this.api.workerHealthy(),
    ]);
    this.state.health.orchestrator = orchestrator;
    this.state.health.worker = worker;
    this.tui.requestRender();
  }

  private async loadTasks(): Promise<void> {
    await this.tasksModel.load(30);
    this.syncTaskSelection();
    this.renderTasks();
    if (this.tasksModel.state.error) this.flash(`Tasks: ${this.tasksModel.state.error}`);
    this.tui.requestRender();
  }

  private visibleTasks(): TaskListItem[] {
    return filterTasks(this.tasksModel.state.tasks, this.state.filter, this.state.query);
  }

  /** Keeps the original-task selection on a visible row after loads and filter changes. */
  private syncTaskSelection(): void {
    const tasks = this.tasksModel.state.tasks;
    const visible = this.visibleTasks();
    if (visible.length === 0) {
      this.tasksModel.state.selected = 0;
      return;
    }
    const selected = tasks[this.tasksModel.state.selected];
    if (selected && visible.some((task) => task.task_id === selected.task_id)) return;
    this.tasksModel.state.selected = Math.max(
      0,
      tasks.findIndex((task) => task.task_id === visible[0].task_id),
    );
  }

  private moveTask(delta: number): void {
    const tasks = this.tasksModel.state.tasks;
    const visible = this.visibleTasks();
    if (visible.length === 0) return;
    const currentId = tasks[this.tasksModel.state.selected]?.task_id;
    const current = visible.findIndex((task) => task.task_id === currentId);
    const next = clamp((current >= 0 ? current : 0) + delta, visible.length);
    this.tasksModel.state.selected = tasks.findIndex(
      (task) => task.task_id === visible[next].task_id,
    );
  }

  private applyTaskFilter(filter: TaskFilter): void {
    this.state.filter = filter;
    this.afterTaskFilterChange(`filter: ${filter}`);
  }

  private applyTaskQuery(query: string): void {
    this.state.query = query.trim();
    this.afterTaskFilterChange(this.state.query ? `search: ${this.state.query}` : "search cleared");
  }

  private clearTaskFilter(): void {
    this.state.filter = "all";
    this.state.query = "";
    this.afterTaskFilterChange("task filter cleared");
  }

  private afterTaskFilterChange(message: string): void {
    this.syncTaskSelection();
    if (this.state.view === "tasks") {
      this.renderTasks();
      this.updateFooter();
    } else {
      this.flash(`${message}; Alt+2 opens Tasks`);
      this.tui.requestRender();
      return;
    }
    this.flash(message);
    this.tui.requestRender();
  }

  private async loadDetail(): Promise<void> {
    if (!this.detailModel) return;
    await this.detailModel.load();
    this.renderDetail();
    if (this.detailModel.state.error) this.flash(`Task detail: ${this.detailModel.state.error}`);
    this.tui.requestRender();
  }

  private openDetail(taskId: string): void {
    if (this.detailModel?.taskId !== taskId) {
      this.detailModel = new TaskDetailPageModel(this.api.client, taskId);
    }
    this.openView("detail");
  }

  private currentTicket(): TicketSummary | null {
    return this.detailModel?.selectedTicket() ?? null;
  }

  private async loadWorkers(): Promise<void> {
    try {
      this.state.workers = await this.api.listWorkers();
      this.renderWorkers();
    } catch (error) {
      this.workersPane.setLines([
        bold("Workers"),
        "",
        red(`unavailable: ${messageOf(error)}`),
        dim("GET /v1/workers requires the Orchestrator workers route."),
      ]);
    }
    this.tui.requestRender();
  }

  private async refreshCurrent(): Promise<void> {
    await this.loadTasks();
    if (this.state.view === "detail" && this.detailModel) await this.loadDetail();
    if (this.state.view === "workers") await this.loadWorkers();
    this.flash("refreshed");
  }

  private startEventStream(): void {
    this.stream = new OrchestratorEventStream(
      this.config.orchestratorUrl,
      this.config.routerToken,
      () => this.state.eventCursor,
      {
        onEvent: (event) => {
          addEvent(this.state, event);
          this.renderEvents();
          this.tui.requestRender();
          this.scheduleRefresh();
        },
        onStatus: (status) => {
          this.state.health.sse = status === "open";
          this.tui.requestRender();
        },
      },
    );
    this.stream.start();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.refreshing) return;
      this.refreshing = true;
      void (async () => {
        try {
          await this.loadTasks();
          if (this.state.view === "detail" && this.detailModel) await this.loadDetail();
          if (this.state.view === "workers") await this.loadWorkers();
        } finally {
          this.refreshing = false;
        }
      })();
    }, 400);
  }

  // ----- chat / Pi ------------------------------------------------------------

  private async startPi(): Promise<void> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(routerEnv(this.config, process.cwd()))) {
      if (typeof value === "string") env[key] = value;
    }
    const client = new RpcClient({
      cliPath: this.config.piCli,
      cwd: process.cwd(),
      env,
      args: buildRouterArgs(this.config, {}),
    });
    this.rpc = client;
    client.onEvent((event) => this.onPiEvent(event));
    try {
      await client.start();
      this.state.health.pi = "idle";
      this.pushChat({ kind: "system", text: "Pi Router ready." });
    } catch (error) {
      this.state.health.pi = "error";
      this.pushChat({ kind: "error", text: `Pi failed to start: ${messageOf(error)}` });
      if (this.piStderr) this.pushChat({ kind: "error", text: this.piStderr.slice(-1200) });
    }
    this.tui.requestRender();
  }

  private onPiEvent(event: JsonAgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.piRunning = true;
        this.state.health.pi = "running";
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.appendAssistant(event.assistantMessageEvent.delta);
        }
        break;
      case "tool_execution_start":
        this.assistantOpen = false;
        this.pushChat({ kind: "tool", text: `\u2699 ${event.toolName} ${formatArgs(event.args)}` });
        break;
      case "tool_execution_end":
        this.assistantOpen = false;
        this.pushChat({
          kind: "tool",
          text: `${event.isError ? red("\u2717") : green("\u2713")} ${event.toolName}${event.durationMs !== undefined ? ` ${event.durationMs}ms` : ""}`,
        });
        break;
      case "agent_settled":
        this.piRunning = false;
        this.assistantOpen = false;
        this.state.health.pi = "idle";
        if (event.aborted) this.pushChat({ kind: "system", text: "aborted" });
        break;
      case "auto_retry_start":
        this.pushChat({ kind: "system", text: `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` });
        break;
      default:
        break;
    }
    this.tui.requestRender();
  }

  private async submitChat(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    this.editor.setText("");
    if (message.startsWith("/")) {
      await this.runSlashCommand(message);
      this.editor.addToHistory(message);
      this.tui.requestRender();
      return;
    }
    this.pushChat({ kind: "user", text: message });
    this.assistantOpen = false;
    if (!this.rpc) {
      this.pushChat({ kind: "error", text: "Pi is not ready yet." });
      return;
    }
    try {
      if (this.piRunning) {
        await this.rpc.steer(message);
        this.pushChat({ kind: "system", text: "steering message queued" });
      } else {
        this.piRunning = true;
        this.state.health.pi = "running";
        const disposition = await this.rpc.prompt(message);
        if (disposition === "handled") {
          this.piRunning = false;
          this.state.health.pi = "idle";
        }
      }
    } catch (error) {
      this.piRunning = false;
      this.state.health.pi = "error";
      this.pushChat({ kind: "error", text: messageOf(error) });
      if (this.piStderr) this.pushChat({ kind: "error", text: this.piStderr.slice(-800) });
    }
    this.editor.addToHistory(message);
    this.tui.requestRender();
  }

  private async abortTurn(): Promise<void> {
    if (!this.rpc) return;
    try {
      await this.rpc.abort();
      this.pushChat({ kind: "system", text: "abort requested" });
    } catch (error) {
      this.pushChat({ kind: "error", text: messageOf(error) });
    }
  }

  private appendAssistant(delta: string): void {
    if (!this.assistantOpen) {
      this.chatLines.push({ kind: "assistant", text: "" });
      this.assistantOpen = true;
    }
    const last = this.chatLines[this.chatLines.length - 1];
    if (last && last.kind === "assistant") last.text += delta;
    this.chatPane.setLines(this.chatLines);
  }

  private pushChat(line: ChatLine): void {
    this.chatLines.push(line);
    if (this.chatLines.length > 400) this.chatLines.splice(0, this.chatLines.length - 400);
    this.chatPane.setLines(this.chatLines);
    this.tui.requestRender();
  }

  // ----- tickets --------------------------------------------------------------

  private async ticketAction(ticketId: string, action: "resume" | "retry" | "cancel"): Promise<void> {
    try {
      if (action === "resume") await this.api.resume(ticketId, "resumed from L3 TUI");
      else if (action === "retry") await this.api.retry(ticketId, "retry from L3 TUI");
      else await this.api.cancelTicket(ticketId, "cancelled from L3 TUI");
      this.flash(`${action} sent for ${ticketId}`);
      await this.loadTasks();
      if (this.detailModel) await this.loadDetail();
    } catch (error) {
      this.flash(`${action} failed: ${messageOf(error)}`);
    }
  }

  private showAnswerDialog(ticket: TicketSummary): void {
    const dialog = new AnswerDialog(`Answer ${ticket.ticket_id}`, ticket.question?.text ?? "");
    const previous = this.focus;
    const handle = this.tui.showOverlay(dialog, { width: "80%", maxHeight: 14, anchor: "center" });
    dialog.input.onSubmit = (value) => {
      handle.hide();
      this.setFocus(previous);
      void this.answerTicket(ticket, value);
    };
    dialog.input.onEscape = () => {
      handle.hide();
      this.setFocus(previous);
    };
    this.tui.requestRender();
  }

  private async answerTicket(ticket: TicketSummary, message: string): Promise<void> {
    if (!message.trim()) return;
    try {
      await this.api.answer(ticket.ticket_id, message);
      this.flash(`answer sent for ${ticket.ticket_id}`);
      await this.loadTasks();
      if (this.detailModel) await this.loadDetail();
    } catch (error) {
      this.flash(`answer failed: ${messageOf(error)}`);
    }
    this.tui.requestRender();
  }

  // ----- rendering ------------------------------------------------------------

  private refreshViews(): void {
    this.renderTasks();
    this.renderDetail();
    this.renderWorkers();
    this.renderEvents();
    this.tui.requestRender();
  }

  private renderTasks(): void {
    const model = this.tasksModel;
    const visible = this.visibleTasks();
    const total = model.state.tasks.length;
    const selectedId = model.selectedTask()?.task_id;
    const count = visible.length === total ? `${total}` : `${visible.length}/${total}`;
    const lines = [bold(`Tasks (${count})`)];
    const active: string[] = [];
    if (this.state.filter !== "all") active.push(`filter:${this.state.filter}`);
    if (this.state.query) active.push(`search:${this.state.query}`);
    if (active.length > 0) lines.push(gray(active.join("  ")));
    lines.push("");
    if (total === 0) lines.push(dim("No tasks yet."));
    else if (visible.length === 0) lines.push(dim("No tasks match this filter/search."));
    for (const task of visible) {
      const marker = task.task_id === selectedId ? cyan("\u25b8") : " ";
      const prompt = oneLine(task.prompt);
      const counts = task.waiting_count > 0 ? yellow(` waiting:${task.waiting_count}`) : "";
      lines.push(`${marker} ${colorStatus(task.status)} ${task.task_id}  ${prompt}${counts}`);
      lines.push(dim(`    tickets ${task.ticket_count} \u00b7 running ${task.running_count} \u00b7 updated ${stamp(task.updated_at)}`));
    }
    this.tasksPane.setLines(lines);
  }

  private renderDetail(): void {
    const model = this.detailModel;
    const task = model?.state.task ?? null;
    if (!task) {
      this.detailPane.setLines(model
        ? [bold(`Task ${model.taskId}`), "", dim("Loading...")]
        : [bold("Task Detail"), "", dim("Select a task from Tasks.")]);
      return;
    }
    const lines = [
      `${bold("Task")} ${task.task_id}  ${colorStatus(task.status)}`,
      gray(oneLine(task.prompt)),
      dim(`created ${stamp(task.created_at)} \u00b7 updated ${stamp(task.updated_at)}`),
      "",
      bold(`Tickets (${task.tickets.length})`),
    ];
    if (task.tickets.length === 0) lines.push(dim("No tickets."));
    task.tickets.forEach((ticket, index) => {
      const marker = index === (model?.state.selected ?? 0) ? cyan("\u25b8") : " ";
      const waiting = ticket.status === "waiting" ? yellow(" \u25cf answer") : "";
      lines.push(`${marker} ${colorStatus(ticket.status)} ${ticket.ticket_id}  ${ticket.profile}  ${oneLine(ticket.title)}${waiting}`);
    });
    const ticket = model?.selectedTicket() ?? null;
    if (ticket) {
      lines.push("", bold("Selected ticket"));
      lines.push(`id: ${ticket.ticket_id}`);
      lines.push(`profile: ${ticket.profile}`);
      lines.push(`status: ${ticket.status}`);
      lines.push(`summary: ${ticket.summary ?? "-"}`);
      lines.push(`question: ${ticket.question ? `${ticket.question.kind}: ${ticket.question.text}` : "-"}`);
      lines.push(`error: ${ticket.error ? `${ticket.error.code}: ${ticket.error.message}` : "-"}`);
      lines.push(`outcome: ${ticket.outcome ?? "-"}`);
      lines.push(`workspace: ${ticket.workspace ?? "-"}`);
      lines.push(`branch: ${ticket.branch ?? "-"}`);
      lines.push(`commit: ${ticket.commit ?? "-"}`);
      lines.push(`delivered_to: ${ticket.delivered_to.length > 0 ? ticket.delivered_to.join(", ") : "-"}`);
      lines.push(`delivery_error: ${ticket.delivery_error ?? "-"}`);
    }
    this.detailPane.setLines(lines);
  }

  private renderWorkers(): void {
    const lines = [bold(`Workers (${this.state.workers.length})`), ""];
    if (this.state.workers.length === 0) lines.push(dim("No registered workers."));
    for (const worker of this.state.workers) {
      lines.push(`${colorStatus(worker.status)} ${worker.worker_id}  ${worker.running}/${worker.max_concurrency} running`);
      lines.push(dim(`    ${worker.url} \u00b7 heartbeat ${stamp(worker.last_heartbeat)} \u00b7 v${worker.version ?? "-"}`));
    }
    this.workersPane.setLines(lines);
  }

  private renderEvents(): void {
    const lines = [bold(`Events  cursor ${this.state.eventCursor}`), ""];
    if (this.state.events.length === 0) lines.push(dim("No events yet."));
    for (const event of this.state.events) lines.push(formatEventLine(event));
    this.eventsPane.setLines(lines);
  }

  private flash(message: string): void {
    this.footer.setTransient(message);
    this.tui.requestRender();
  }

  private updateFooter(): void {
    if (this.state.view !== "tasks") {
      this.footer.text = FOOTER_HELP[this.state.view];
      return;
    }
    const search = this.state.query ? ` \u00b7 search:${this.state.query}` : "";
    this.footer.text = `${FOOTER_HELP.tasks} \u00b7 filter:${this.state.filter}${search}`;
  }

  private installStderrCapture(): void {
    const capture = (chunk: unknown): boolean => {
      this.piStderr += String(chunk);
      if (this.piStderr.length > 8000) this.piStderr = this.piStderr.slice(-4000);
      return true;
    };
    (process.stderr as { write: unknown }).write = capture;
  }
}

function colorStatus(status: string): string {
  if (status === "succeeded") return green(status);
  if (status === "failed" || status === "cancelled" || status === "timed_out" || status === "lost") return red(status);
  if (status === "waiting" || status === "blocked") return yellow(status);
  if (status === "running" || status === "assigned" || status === "healthy") return cyan(status);
  return gray(status);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stamp(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args);
    if (!text) return "";
    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  } catch {
    return "";
  }
}

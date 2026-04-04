import {
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  CopilotClient,
  type CopilotSession,
  type MessageOptions,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from "@github/copilot-sdk";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import {
  GitHubCopilotAdapter,
  type GitHubCopilotAdapterShape,
} from "../Services/GitHubCopilotAdapter.ts";
import { buildGitHubCopilotSessionId, createGitHubCopilotClient } from "../githubCopilotSdk";

const PROVIDER = "githubCopilot" as const;
type CopilotPermissionEventRequest = Extract<
  SessionEvent,
  { type: "permission.requested" }
>["data"]["permissionRequest"];
type CopilotPermissionLike = PermissionRequest | CopilotPermissionEventRequest;

interface UserInputRequest {
  readonly question: string;
  readonly choices?: ReadonlyArray<string> | undefined;
  readonly allowFreeform?: boolean | undefined;
}

interface UserInputResponse {
  readonly answer: string;
  readonly wasFreeform: boolean;
}

interface PromiseDeferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

interface CopilotTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  providerTurnId?: string;
  readonly items: Array<unknown>;
  readonly streamedAssistantMessageIds: Set<string>;
  readonly streamedReasoningIds: Set<string>;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string | undefined;
  readonly args?: unknown;
  readonly decision: PromiseDeferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: PromiseDeferred<Record<string, unknown>>;
}

interface ApprovalBridge {
  readonly fingerprint: string;
  readonly request: PermissionRequest;
  readonly decision: PromiseDeferred<ProviderApprovalDecision>;
}

interface UserInputBridge {
  readonly fingerprint: string;
  readonly request: UserInputRequest;
  readonly answers: PromiseDeferred<Record<string, unknown>>;
}

interface QueuedPermissionEvent {
  readonly event: Extract<SessionEvent, { type: "permission.requested" }>;
  readonly fingerprint: string;
}

interface QueuedUserInputEvent {
  readonly event: Extract<SessionEvent, { type: "user_input.requested" }>;
  readonly fingerprint: string;
}

interface ToolState {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly toolName: string;
  readonly input?: unknown;
  readonly detail?: string;
}

interface CopilotSessionContext {
  session: ProviderSession;
  readonly client: CopilotClient;
  sdkSession: CopilotSession | undefined;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly pendingUserInputs: Map<string, PendingUserInput>;
  readonly approvalBridges: Array<ApprovalBridge>;
  readonly userInputBridges: Array<UserInputBridge>;
  readonly queuedPermissionEvents: Array<QueuedPermissionEvent>;
  readonly queuedUserInputEvents: Array<QueuedUserInputEvent>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly inFlightTools: Map<string, ToolState>;
  currentTurn: CopilotTurnState | undefined;
  lastKnownUsage: ThreadTokenUsageSnapshot | undefined;
  stopped: boolean;
}

function createDeferred<T>(): PromiseDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const sortedEntries = Object.entries(value as Record<string, unknown>).toSorted(
    ([left], [right]) => left.localeCompare(right),
  );
  return Object.fromEntries(sortedEntries.map(([key, nested]) => [key, stableValue(nested)]));
}

function fingerprintValue(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function asRuntimeRequestId(value: string) {
  return RuntimeRequestId.makeUnsafe(value);
}

function asRuntimeItemId(value: string) {
  return RuntimeItemId.makeUnsafe(value);
}

function asProviderItemId(value: string) {
  return ProviderItemId.makeUnsafe(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function toErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function truncateText(value: string, limit = 240): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function humanizeToolName(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return "Tool call";
  }
  return normalized
    .split(" ")
    .map((part) => (part.length > 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

function extractPathLike(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of [
    "path",
    "filePath",
    "file_path",
    "filename",
    "relativePath",
    "relative_path",
    "url",
  ]) {
    const candidate = asTrimmedString(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function extractQueryLike(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of ["query", "search", "searchTerm", "search_term", "pattern", "glob", "regex"]) {
    const candidate = asTrimmedString(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function extractTextLike(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const combined = value
      .map((entry) => extractTextLike(entry))
      .filter((entry): entry is string => entry !== undefined)
      .join("\n")
      .trim();
    return combined.length > 0 ? combined : undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of ["detailedContent", "content", "text", "message", "summary"]) {
    const nested = extractTextLike(record[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function summarizeStructuredValue(value: unknown, prefix?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(stableValue(value));
    if (!serialized || serialized === "{}" || serialized === "[]") {
      return undefined;
    }
    return prefix ? `${prefix}: ${truncateText(serialized)}` : truncateText(serialized);
  } catch {
    return undefined;
  }
}

function detailForToolLifecycle(input: {
  readonly toolName: string;
  readonly arguments?: unknown;
  readonly result?: unknown;
  readonly success?: boolean;
}): string | undefined {
  const argsRecord = asRecord(input.arguments);
  const resultRecord = asRecord(input.result);
  const command =
    normalizeCommandValue(argsRecord?.command ?? argsRecord?.cmd) ??
    normalizeCommandValue(resultRecord?.command);
  if (command) {
    return truncateText(command);
  }
  const path = extractPathLike(argsRecord) ?? extractPathLike(resultRecord);
  if (path) {
    return truncateText(path);
  }
  const query = extractQueryLike(argsRecord) ?? extractQueryLike(resultRecord);
  if (query) {
    return truncateText(query);
  }
  const resultText = extractTextLike(input.result);
  if (resultText) {
    return truncateText(resultText);
  }
  const summarizedArgs = summarizeStructuredValue(
    input.arguments,
    humanizeToolName(input.toolName),
  );
  if (summarizedArgs) {
    return summarizedArgs;
  }
  if (input.success === false) {
    return "Failed";
  }
  if (input.success === true) {
    return "Completed";
  }
  return undefined;
}

function currentTurnId(context: CopilotSessionContext): TurnId | undefined {
  return context.currentTurn?.turnId;
}

function currentRuntimeTurnId(context: CopilotSessionContext): TurnId | undefined {
  return currentTurnId(context);
}

function detailFromPermissionRequest(request: CopilotPermissionLike): string | undefined {
  switch (request.kind) {
    case "shell":
      return typeof request.intention === "string"
        ? request.intention
        : typeof request.fullCommandText === "string"
          ? request.fullCommandText
          : undefined;
    case "write":
      return typeof request.intention === "string"
        ? request.intention
        : typeof request.fileName === "string"
          ? request.fileName
          : undefined;
    case "read":
      return typeof request.path === "string" ? request.path : undefined;
    case "url":
      return typeof request.url === "string" ? request.url : undefined;
    case "mcp":
      return typeof request.toolTitle === "string" ? request.toolTitle : undefined;
    case "custom-tool":
      return typeof request.toolDescription === "string" ? request.toolDescription : undefined;
    default:
      return undefined;
  }
}

function canonicalRequestTypeFromPermissionRequest(
  request: CopilotPermissionLike,
): CanonicalRequestType {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "write":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

function permissionResultFromDecision(decision: ProviderApprovalDecision): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
    case "cancel":
    default:
      return { kind: "denied-interactively-by-user" };
  }
}

function questionFromUserInputRequest(request: UserInputRequest): UserInputQuestion {
  return {
    id: "answer",
    header: "Copilot",
    question: request.question,
    options: (request.choices ?? []).map((choice: string) => ({
      label: choice,
      description: `Use ${choice}.`,
    })),
  };
}

function answerFromUserInput(
  answers: Record<string, unknown>,
  request: UserInputRequest,
): UserInputResponse {
  const firstString = Object.values(answers).find(
    (value): value is string => typeof value === "string",
  );
  const answer = firstString ?? "";
  return {
    answer,
    wasFreeform: !(request.choices ?? []).includes(answer),
  };
}

function itemTypeFromTool(toolName: string, mcpServerName?: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (mcpServerName) {
    return "mcp_tool_call";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("exec") ||
    normalized.includes("command") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  if (normalized.includes("search") || normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("image") || normalized.includes("view")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function titleForTool(toolName: string, itemType: CanonicalItemType): string {
  const humanized = humanizeToolName(toolName);
  if (humanized.length > 0) {
    return humanized;
  }
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "View";
    default:
      return "Tool call";
  }
}

function outputStreamKindForItemType(itemType: CanonicalItemType) {
  switch (itemType) {
    case "command_execution":
      return "command_output" as const;
    case "file_change":
      return "file_change_output" as const;
    default:
      return "unknown" as const;
  }
}

function usageSnapshotFromEvent(
  previous: ThreadTokenUsageSnapshot | undefined,
  event: Extract<SessionEvent, { type: "assistant.usage" }>,
): ThreadTokenUsageSnapshot {
  const inputTokens = event.data.inputTokens ?? 0;
  const outputTokens = event.data.outputTokens ?? 0;
  const cachedInputTokens = event.data.cacheReadTokens ?? 0;
  const usedThisCall = inputTokens + outputTokens + cachedInputTokens;

  return {
    usedTokens: (previous?.usedTokens ?? 0) + usedThisCall,
    totalProcessedTokens: (previous?.totalProcessedTokens ?? 0) + usedThisCall,
    inputTokens: (previous?.inputTokens ?? 0) + inputTokens,
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + cachedInputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + outputTokens,
    lastUsedTokens: usedThisCall,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    durationMs: event.data.duration,
  };
}

function buildResumeCursor(context: {
  readonly sessionId: string;
  readonly model?: string | undefined;
}) {
  return {
    sessionId: context.sessionId,
    ...(context.model ? { model: context.model } : {}),
  };
}

const buildMessageOptions = Effect.fn("buildMessageOptions")(function* (
  input: ProviderSendTurnInput,
  attachmentsDir: string,
  fileSystem: FileSystem.FileSystem,
) {
  const attachments: NonNullable<MessageOptions["attachments"]> = [];

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: toErrorMessage(cause, "Failed to read attachment file."),
            cause,
          }),
      ),
    );

    attachments.push({
      type: "file",
      path: attachmentPath,
      displayName: attachment.name,
    });
  }

  return {
    prompt: input.input?.trim() ?? "",
    ...(attachments.length > 0 ? { attachments } : {}),
    mode: "immediate" as const,
  } satisfies MessageOptions;
});

const makeGitHubCopilotAdapter = Effect.fn("makeGitHubCopilotAdapter")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CopilotSessionContext>();

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const emitRuntimeEvent = (event: ProviderRuntimeEvent): void => {
    void Effect.runPromise(offerRuntimeEvent(event));
  };

  const makeBaseEvent = (
    context: CopilotSessionContext,
    input: {
      readonly type: ProviderRuntimeEvent["type"];
      readonly createdAt?: string | undefined;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: RuntimeItemId | undefined;
      readonly requestId?: RuntimeRequestId | undefined;
      readonly providerRefs?: ProviderRuntimeEvent["providerRefs"] | undefined;
      readonly payload: unknown;
    },
  ): ProviderRuntimeEvent =>
    ({
      type: input.type,
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: input.createdAt ?? nowIso(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.providerRefs ? { providerRefs: input.providerRefs } : {}),
      payload: input.payload,
    }) as ProviderRuntimeEvent;

  const emitUnsupportedEventWarning = (
    context: CopilotSessionContext,
    event: SessionEvent,
  ): void => {
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "runtime.warning",
        createdAt: event.timestamp,
        turnId: currentRuntimeTurnId(context),
        payload: {
          message: `${event.type} is not supported by the GitHub Copilot adapter.`,
          class: "provider_error",
        },
      }),
    );
  };

  const activatePermissionEvent = (
    context: CopilotSessionContext,
    bridge: ApprovalBridge,
    event: Extract<SessionEvent, { type: "permission.requested" }>,
  ): void => {
    const runtimeRequestId = asRuntimeRequestId(event.data.requestId);
    context.pendingApprovals.set(event.data.requestId, {
      requestType: canonicalRequestTypeFromPermissionRequest(event.data.permissionRequest),
      detail: detailFromPermissionRequest(event.data.permissionRequest),
      args: event.data.permissionRequest,
      decision: bridge.decision,
    });
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "request.opened",
        createdAt: event.timestamp,
        turnId: currentRuntimeTurnId(context),
        requestId: runtimeRequestId,
        providerRefs: {
          providerRequestId: event.data.requestId,
          ...(typeof event.data.permissionRequest.toolCallId === "string"
            ? {
                providerItemId: asProviderItemId(event.data.permissionRequest.toolCallId),
              }
            : {}),
        },
        payload: {
          requestType: canonicalRequestTypeFromPermissionRequest(event.data.permissionRequest),
          ...(detailFromPermissionRequest(event.data.permissionRequest)
            ? {
                detail: detailFromPermissionRequest(event.data.permissionRequest),
              }
            : {}),
          args: event.data.permissionRequest,
        },
      }),
    );
  };

  const activateUserInputEvent = (
    context: CopilotSessionContext,
    bridge: UserInputBridge,
    event: Extract<SessionEvent, { type: "user_input.requested" }>,
  ): void => {
    const questions = [questionFromUserInputRequest(bridge.request)];
    context.pendingUserInputs.set(event.data.requestId, {
      questions,
      answers: bridge.answers,
    });
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "user-input.requested",
        createdAt: event.timestamp,
        turnId: currentRuntimeTurnId(context),
        requestId: asRuntimeRequestId(event.data.requestId),
        providerRefs: {
          providerRequestId: event.data.requestId,
          ...(event.data.toolCallId
            ? { providerItemId: asProviderItemId(event.data.toolCallId) }
            : {}),
        },
        payload: {
          questions,
        },
      }),
    );
  };

  const tryMatchQueuedPermissionEvent = (
    context: CopilotSessionContext,
    bridge: ApprovalBridge,
  ): boolean => {
    const index = context.queuedPermissionEvents.findIndex(
      (candidate) => candidate.fingerprint === bridge.fingerprint,
    );
    if (index === -1) {
      return false;
    }
    const [queued] = context.queuedPermissionEvents.splice(index, 1);
    if (!queued) {
      return false;
    }
    activatePermissionEvent(context, bridge, queued.event);
    return true;
  };

  const tryMatchQueuedUserInputEvent = (
    context: CopilotSessionContext,
    bridge: UserInputBridge,
  ): boolean => {
    const index = context.queuedUserInputEvents.findIndex(
      (candidate) => candidate.fingerprint === bridge.fingerprint,
    );
    if (index === -1) {
      return false;
    }
    const [queued] = context.queuedUserInputEvents.splice(index, 1);
    if (!queued) {
      return false;
    }
    activateUserInputEvent(context, bridge, queued.event);
    return true;
  };

  const updateSession = (
    context: CopilotSessionContext,
    update: Partial<ProviderSession>,
  ): void => {
    context.session = {
      ...context.session,
      ...update,
      updatedAt: nowIso(),
    };
  };

  const finishTurn = (context: CopilotSessionContext): CopilotTurnState | undefined => {
    const currentTurn = context.currentTurn;
    if (!currentTurn) {
      return undefined;
    }
    context.turns.push({
      id: currentTurn.turnId,
      items: [...currentTurn.items],
    });
    context.currentTurn = undefined;
    updateSession(context, {
      activeTurnId: undefined,
      status: "ready",
    });
    return currentTurn;
  };

  const handleSessionEvent = (context: CopilotSessionContext, event: SessionEvent): void => {
    if (context.stopped) {
      return;
    }

    switch (event.type) {
      case "assistant.turn_start": {
        if (context.currentTurn) {
          context.currentTurn.providerTurnId = event.data.turnId;
        }
        return;
      }
      case "assistant.message_delta": {
        if (!context.currentTurn) {
          return;
        }
        context.currentTurn.streamedAssistantMessageIds.add(event.data.messageId);
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "content.delta",
            createdAt: event.timestamp,
            turnId: context.currentTurn.turnId,
            payload: {
              streamKind: "assistant_text",
              delta: event.data.deltaContent,
            },
            ...(event.data.messageId
              ? {
                  itemId: asRuntimeItemId(`copilot-message:${event.data.messageId}`),
                  providerRefs: {
                    providerItemId: asProviderItemId(event.data.messageId),
                  },
                }
              : {}),
          }),
        );
        return;
      }
      case "assistant.message": {
        if (!context.currentTurn) {
          return;
        }
        if (
          event.data.content.length > 0 &&
          !context.currentTurn.streamedAssistantMessageIds.has(event.data.messageId)
        ) {
          emitRuntimeEvent(
            makeBaseEvent(context, {
              type: "content.delta",
              createdAt: event.timestamp,
              turnId: context.currentTurn.turnId,
              itemId: asRuntimeItemId(`copilot-message:${event.data.messageId}`),
              providerRefs: {
                providerItemId: asProviderItemId(event.data.messageId),
              },
              payload: {
                streamKind: "assistant_text",
                delta: event.data.content,
              },
            }),
          );
        }
        return;
      }
      case "assistant.reasoning_delta": {
        if (!context.currentTurn) {
          return;
        }
        context.currentTurn.streamedReasoningIds.add(event.data.reasoningId);
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "content.delta",
            createdAt: event.timestamp,
            turnId: context.currentTurn.turnId,
            itemId: asRuntimeItemId(`copilot-reasoning:${event.data.reasoningId}`),
            providerRefs: {
              providerItemId: asProviderItemId(event.data.reasoningId),
            },
            payload: {
              streamKind: "reasoning_text",
              delta: event.data.deltaContent,
            },
          }),
        );
        return;
      }
      case "assistant.reasoning": {
        if (!context.currentTurn) {
          return;
        }
        if (
          event.data.content.length > 0 &&
          !context.currentTurn.streamedReasoningIds.has(event.data.reasoningId)
        ) {
          emitRuntimeEvent(
            makeBaseEvent(context, {
              type: "content.delta",
              createdAt: event.timestamp,
              turnId: context.currentTurn.turnId,
              itemId: asRuntimeItemId(`copilot-reasoning:${event.data.reasoningId}`),
              providerRefs: {
                providerItemId: asProviderItemId(event.data.reasoningId),
              },
              payload: {
                streamKind: "reasoning_text",
                delta: event.data.content,
              },
            }),
          );
        }
        return;
      }
      case "assistant.usage": {
        context.lastKnownUsage = usageSnapshotFromEvent(context.lastKnownUsage, event);
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "thread.token-usage.updated",
            createdAt: event.timestamp,
            turnId: currentRuntimeTurnId(context),
            payload: {
              usage: context.lastKnownUsage,
            },
          }),
        );
        return;
      }
      case "tool.execution_start": {
        const itemType = itemTypeFromTool(event.data.toolName, event.data.mcpServerName);
        const itemId = `copilot-tool:${event.data.toolCallId}`;
        const title = titleForTool(event.data.toolName, itemType);
        const detail = detailForToolLifecycle({
          toolName: event.data.toolName,
          arguments: event.data.arguments,
        });
        context.inFlightTools.set(event.data.toolCallId, {
          itemId,
          itemType,
          title,
          toolName: event.data.toolName,
          input: event.data.arguments,
          ...(detail ? { detail } : {}),
        });
        context.currentTurn?.items.push({
          type: "tool",
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
        });
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "item.started",
            createdAt: event.timestamp,
            turnId: currentRuntimeTurnId(context),
            itemId: asRuntimeItemId(itemId),
            providerRefs: {
              providerItemId: asProviderItemId(event.data.toolCallId),
            },
            payload: {
              itemType,
              status: "inProgress",
              title,
              ...(detail ? { detail } : {}),
            },
          }),
        );
        return;
      }
      case "tool.execution_partial_result": {
        const tool = context.inFlightTools.get(event.data.toolCallId);
        if (!tool) {
          return;
        }
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "content.delta",
            createdAt: event.timestamp,
            turnId: currentRuntimeTurnId(context),
            itemId: asRuntimeItemId(tool.itemId),
            providerRefs: {
              providerItemId: asProviderItemId(event.data.toolCallId),
            },
            payload: {
              streamKind: outputStreamKindForItemType(tool.itemType),
              delta: event.data.partialOutput,
            },
          }),
        );
        return;
      }
      case "tool.execution_progress": {
        const tool = context.inFlightTools.get(event.data.toolCallId);
        if (!tool) {
          return;
        }
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "tool.progress",
            createdAt: event.timestamp,
            turnId: currentRuntimeTurnId(context),
            itemId: asRuntimeItemId(tool.itemId),
            providerRefs: {
              providerItemId: asProviderItemId(event.data.toolCallId),
            },
            payload: {
              summary: event.data.progressMessage,
            },
          }),
        );
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "item.updated",
            createdAt: event.timestamp,
            turnId: currentRuntimeTurnId(context),
            itemId: asRuntimeItemId(tool.itemId),
            providerRefs: {
              providerItemId: asProviderItemId(event.data.toolCallId),
            },
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              detail: event.data.progressMessage,
            },
          }),
        );
        return;
      }
      case "tool.execution_complete": {
        const tool = context.inFlightTools.get(event.data.toolCallId);
        if (!tool) {
          return;
        }
        context.inFlightTools.delete(event.data.toolCallId);
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "item.completed",
            createdAt: event.timestamp,
            turnId: currentRuntimeTurnId(context),
            itemId: asRuntimeItemId(tool.itemId),
            providerRefs: {
              providerItemId: asProviderItemId(event.data.toolCallId),
            },
            payload: {
              itemType: tool.itemType,
              status: event.data.success ? "completed" : "failed",
              title: tool.title,
              detail:
                detailForToolLifecycle({
                  toolName: tool.toolName,
                  arguments: tool.input,
                  result: event.data.result,
                  success: event.data.success,
                }) ?? (event.data.success ? "Completed" : "Failed"),
            },
          }),
        );
        const finalOutput =
          event.data.result?.detailedContent ?? event.data.result?.content ?? undefined;
        if (finalOutput && finalOutput.length > 0) {
          emitRuntimeEvent(
            makeBaseEvent(context, {
              type: "content.delta",
              createdAt: event.timestamp,
              turnId: currentRuntimeTurnId(context),
              itemId: asRuntimeItemId(tool.itemId),
              providerRefs: {
                providerItemId: asProviderItemId(event.data.toolCallId),
              },
              payload: {
                streamKind: outputStreamKindForItemType(tool.itemType),
                delta: finalOutput,
              },
            }),
          );
        }
        return;
      }
      case "permission.requested": {
        const fingerprint = fingerprintValue(event.data.permissionRequest);
        const bridgeIndex = context.approvalBridges.findIndex(
          (candidate) => candidate.fingerprint === fingerprint,
        );
        if (bridgeIndex === -1) {
          context.queuedPermissionEvents.push({ event, fingerprint });
          return;
        }
        const [bridge] = context.approvalBridges.splice(bridgeIndex, 1);
        if (!bridge) {
          return;
        }
        activatePermissionEvent(context, bridge, event);
        return;
      }
      case "permission.completed": {
        context.pendingApprovals.delete(event.data.requestId);
        return;
      }
      case "user_input.requested": {
        const fingerprint = fingerprintValue({
          question: event.data.question,
          choices: event.data.choices ?? [],
          allowFreeform: event.data.allowFreeform ?? true,
        });
        const bridgeIndex = context.userInputBridges.findIndex(
          (candidate) => candidate.fingerprint === fingerprint,
        );
        if (bridgeIndex === -1) {
          context.queuedUserInputEvents.push({ event, fingerprint });
          return;
        }
        const [bridge] = context.userInputBridges.splice(bridgeIndex, 1);
        if (!bridge) {
          return;
        }
        activateUserInputEvent(context, bridge, event);
        return;
      }
      case "user_input.completed": {
        context.pendingUserInputs.delete(event.data.requestId);
        return;
      }
      case "exit_plan_mode.requested": {
        if (!context.currentTurn) {
          return;
        }
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "turn.proposed.completed",
            createdAt: event.timestamp,
            turnId: context.currentTurn.turnId,
            requestId: asRuntimeRequestId(event.data.requestId),
            providerRefs: {
              providerRequestId: event.data.requestId,
            },
            payload: {
              planMarkdown: event.data.planContent,
            },
          }),
        );
        if (context.sdkSession) {
          void context.sdkSession.rpc.mode.set({ mode: "interactive" }).catch(() => undefined);
        }
        return;
      }
      case "session.idle": {
        const finishedTurn = finishTurn(context);
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "session.state.changed",
            createdAt: event.timestamp,
            payload: {
              state: "ready",
            },
          }),
        );
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "thread.state.changed",
            createdAt: event.timestamp,
            payload: {
              state: "idle",
            },
          }),
        );
        if (finishedTurn) {
          emitRuntimeEvent(
            makeBaseEvent(context, {
              type: "turn.completed",
              createdAt: event.timestamp,
              turnId: finishedTurn.turnId,
              payload: {
                state: "completed",
                ...(context.lastKnownUsage ? { usage: context.lastKnownUsage } : {}),
              },
            }),
          );
        }
        return;
      }
      case "abort": {
        const finishedTurn = finishTurn(context);
        if (finishedTurn) {
          emitRuntimeEvent(
            makeBaseEvent(context, {
              type: "turn.aborted",
              createdAt: event.timestamp,
              turnId: finishedTurn.turnId,
              payload: {
                reason: event.data.reason,
              },
            }),
          );
        }
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "session.state.changed",
            createdAt: event.timestamp,
            payload: {
              state: "ready",
              reason: event.data.reason,
            },
          }),
        );
        return;
      }
      case "session.error": {
        updateSession(context, {
          status: "error",
          lastError: event.data.message,
          activeTurnId: undefined,
        });
        const finishedTurn = finishTurn(context);
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "runtime.error",
            createdAt: event.timestamp,
            payload: {
              message: event.data.message,
              class: "provider_error",
              detail: event.data,
            },
          }),
        );
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "session.state.changed",
            createdAt: event.timestamp,
            payload: {
              state: "error",
              reason: event.data.message,
              detail: event.data,
            },
          }),
        );
        if (finishedTurn) {
          emitRuntimeEvent(
            makeBaseEvent(context, {
              type: "turn.completed",
              createdAt: event.timestamp,
              turnId: finishedTurn.turnId,
              payload: {
                state: "failed",
                errorMessage: event.data.message,
              },
            }),
          );
        }
        return;
      }
      case "external_tool.requested":
      case "command.queued":
      case "elicitation.requested": {
        emitUnsupportedEventWarning(context, event);
        return;
      }
      default:
        return;
    }
  };

  const requireSession = (threadId: ThreadId) =>
    Effect.sync(() => sessions.get(threadId)).pipe(
      Effect.flatMap((context) =>
        context && !context.stopped
          ? Effect.succeed(context)
          : Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              }),
            ),
      ),
    );

  const stopSessionInternal = (context: CopilotSessionContext, emitExitEvent: boolean) =>
    Effect.promise(async () => {
      if (context.stopped) {
        return;
      }
      context.stopped = true;
      sessions.delete(context.session.threadId);

      for (const pending of context.pendingApprovals.values()) {
        pending.decision.reject(new Error("GitHub Copilot session stopped."));
      }
      context.pendingApprovals.clear();

      for (const pending of context.pendingUserInputs.values()) {
        pending.answers.reject(new Error("GitHub Copilot session stopped."));
      }
      context.pendingUserInputs.clear();

      if (context.sdkSession) {
        await context.sdkSession.disconnect().catch(() => undefined);
      }
      await context.client.stop().catch(() => undefined);

      if (emitExitEvent) {
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "session.exited",
            payload: {
              exitKind: "graceful",
            },
          }),
        );
      }
    });

  const startSession: GitHubCopilotAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        return existing.session;
      }

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.map((allSettings) => allSettings.providers.githubCopilot),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: toErrorMessage(cause, "Failed to read GitHub Copilot settings."),
              cause,
            }),
        ),
      );
      const sessionId =
        input.resumeCursor &&
        typeof input.resumeCursor === "object" &&
        input.resumeCursor !== null &&
        "sessionId" in input.resumeCursor &&
        typeof input.resumeCursor.sessionId === "string"
          ? input.resumeCursor.sessionId
          : buildGitHubCopilotSessionId(input.threadId);
      const selectedModel =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
      const client = createGitHubCopilotClient({
        binaryPath: settings.binaryPath,
        cwd: input.cwd ?? serverConfig.cwd,
      });

      const createdAt = nowIso();
      const context: CopilotSessionContext = {
        session: {
          provider: PROVIDER,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd ?? serverConfig.cwd,
          ...(selectedModel ? { model: selectedModel } : {}),
          threadId: input.threadId,
          resumeCursor: buildResumeCursor({
            sessionId,
            model: selectedModel,
          }),
          createdAt,
          updatedAt: createdAt,
        },
        client,
        sdkSession: undefined,
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        approvalBridges: [],
        userInputBridges: [],
        queuedPermissionEvents: [],
        queuedUserInputEvents: [],
        turns: [],
        inFlightTools: new Map(),
        currentTurn: undefined,
        lastKnownUsage: undefined,
        stopped: false,
      };

      const permissionHandler = async (
        request: PermissionRequest,
      ): Promise<PermissionRequestResult> => {
        if (context.session.runtimeMode === "full-access") {
          return { kind: "approved" };
        }
        const bridge: ApprovalBridge = {
          fingerprint: fingerprintValue(request),
          request,
          decision: createDeferred<ProviderApprovalDecision>(),
        };
        context.approvalBridges.push(bridge);
        tryMatchQueuedPermissionEvent(context, bridge);
        return permissionResultFromDecision(await bridge.decision.promise);
      };

      const userInputHandler = async (request: UserInputRequest): Promise<UserInputResponse> => {
        const bridge: UserInputBridge = {
          fingerprint: fingerprintValue({
            question: request.question,
            choices: request.choices ?? [],
            allowFreeform: request.allowFreeform ?? true,
          }),
          request,
          answers: createDeferred<Record<string, unknown>>(),
        };
        context.userInputBridges.push(bridge);
        tryMatchQueuedUserInputEvent(context, bridge);
        const answers = await bridge.answers.promise;
        return answerFromUserInput(answers, request);
      };

      const sessionConfig = {
        sessionId,
        ...(selectedModel ? { model: selectedModel } : {}),
        workingDirectory: input.cwd ?? serverConfig.cwd,
        streaming: true,
        onPermissionRequest: permissionHandler,
        onUserInputRequest: userInputHandler,
        onEvent: (event: SessionEvent) => {
          handleSessionEvent(context, event);
        },
      } as const;

      const sdkSession = yield* Effect.tryPromise(async () => {
        await client.start();
        if (
          input.resumeCursor &&
          typeof input.resumeCursor === "object" &&
          input.resumeCursor !== null &&
          "sessionId" in input.resumeCursor
        ) {
          try {
            return await client.resumeSession(sessionId, sessionConfig);
          } catch {
            return await client.createSession(sessionConfig);
          }
        }
        return await client.createSession(sessionConfig);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: toErrorMessage(cause, "Failed to start GitHub Copilot session."),
              cause,
            }),
        ),
      );

      context.sdkSession = sdkSession;
      updateSession(context, {
        status: "ready",
        resumeCursor: buildResumeCursor({
          sessionId: sdkSession.sessionId,
          model: selectedModel,
        }),
      });
      sessions.set(input.threadId, context);

      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "session.started",
          payload: {
            resume: context.session.resumeCursor,
          },
        }),
      );
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "session.configured",
          payload: {
            config: {
              cwd: context.session.cwd ?? null,
              model: context.session.model ?? null,
              runtimeMode: context.session.runtimeMode,
            },
          },
        }),
      );
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "session.state.changed",
          payload: {
            state: "ready",
          },
        }),
      );
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "thread.started",
          payload: {
            providerThreadId: sdkSession.sessionId,
          },
        }),
      );

      return context.session;
    },
  );

  const sendTurn: GitHubCopilotAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (context.session.activeTurnId) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "A GitHub Copilot turn is already running for this thread.",
      });
    }

    const turnId = TurnId.makeUnsafe(`copilot-turn:${crypto.randomUUID()}`);
    context.currentTurn = {
      turnId,
      startedAt: nowIso(),
      items: [],
      streamedAssistantMessageIds: new Set(),
      streamedReasoningIds: new Set(),
    };
    updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(input.modelSelection?.provider === PROVIDER ? { model: input.modelSelection.model } : {}),
      resumeCursor: buildResumeCursor({
        sessionId: context.sdkSession?.sessionId ?? buildGitHubCopilotSessionId(input.threadId),
        model:
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.model
            : context.session.model,
      }),
      lastError: undefined,
    });

    if (context.sdkSession) {
      yield* Effect.tryPromise(async () => {
        await context.sdkSession!.rpc.mode.set({
          mode: input.interactionMode === "plan" ? "plan" : "interactive",
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.mode.set",
              detail: toErrorMessage(cause, "Failed to configure GitHub Copilot interaction mode."),
              cause,
            }),
        ),
      );
    }

    const messageOptions = yield* buildMessageOptions(
      input,
      serverConfig.attachmentsDir,
      fileSystem,
    );

    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "session.state.changed",
        turnId,
        payload: {
          state: "running",
        },
      }),
    );
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "thread.state.changed",
        turnId,
        payload: {
          state: "active",
        },
      }),
    );
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "turn.started",
        turnId,
        payload: context.session.model ? { model: context.session.model } : {},
      }),
    );

    yield* Effect.tryPromise(() => context.sdkSession!.send(messageOptions)).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: toErrorMessage(cause, "Failed to send turn to GitHub Copilot."),
            cause,
          }),
      ),
    );

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: context.session.resumeCursor,
    };
  });

  const interruptTurn: GitHubCopilotAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* Effect.tryPromise(() => context.sdkSession!.abort()).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/interrupt",
              detail: toErrorMessage(cause, "Failed to interrupt GitHub Copilot turn."),
              cause,
            }),
        ),
      );
    },
  );

  const readThread: GitHubCopilotAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.map((context) => ({
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: turn.items,
        })),
      })),
    );

  const rollbackThread: GitHubCopilotAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (_threadId, _numTurns) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "GitHub Copilot does not support conversation rollback.",
      });
    },
  );

  const respondToRequest: GitHubCopilotAdapterShape["respondToRequest"] = Effect.fn(
    "respondToRequest",
  )(function* (threadId, requestId, decision) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "request/respond",
        detail: `Unknown pending approval request: ${requestId}`,
      });
    }
    context.pendingApprovals.delete(requestId);
    pending.decision.resolve(decision);
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "request.resolved",
        requestId: asRuntimeRequestId(requestId),
        turnId: currentRuntimeTurnId(context),
        payload: {
          requestType: pending.requestType,
          decision,
          resolution: {
            args: pending.args,
          },
        },
      }),
    );
  });

  const respondToUserInput: GitHubCopilotAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user-input/respond",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }
    context.pendingUserInputs.delete(requestId);
    pending.answers.resolve(answers);
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "user-input.resolved",
        requestId: asRuntimeRequestId(requestId),
        turnId: currentRuntimeTurnId(context),
        payload: {
          answers,
        },
      }),
    );
  });

  const stopSession: GitHubCopilotAdapterShape["stopSession"] = (threadId) =>
    requireSession(threadId).pipe(Effect.flatMap((context) => stopSessionInternal(context, true)));

  const listSessions: GitHubCopilotAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: GitHubCopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: GitHubCopilotAdapterShape["stopAll"] = () =>
    Effect.forEach(sessions, ([, context]) => stopSessionInternal(context, true), {
      discard: true,
    });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions, ([, context]) => stopSessionInternal(context, false), {
      discard: true,
    }).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
      supportsConversationRollback: false,
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies GitHubCopilotAdapterShape;
});

export const GitHubCopilotAdapterLive = Layer.effect(
  GitHubCopilotAdapter,
  makeGitHubCopilotAdapter(),
);

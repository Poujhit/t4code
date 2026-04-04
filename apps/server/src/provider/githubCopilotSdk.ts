import type { ModelCapabilities, ServerProviderModel, ThreadId } from "@t3tools/contracts";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";

const PREFERRED_MODEL_ORDER = ["gpt-5-codex", "gpt-5", "gpt-4.1"] as const;

function titleCaseReasoningEffort(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return value;
  }
}

export function buildGitHubCopilotSessionId(threadId: ThreadId | string): string {
  return `t3code-thread-${String(threadId)}`;
}

export function createGitHubCopilotClient(input: {
  readonly binaryPath: string;
  readonly cwd?: string;
}) {
  return new CopilotClient({
    cliPath: input.binaryPath,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    useStdio: true,
    autoStart: false,
    useLoggedInUser: true,
    logLevel: "error",
  });
}

export function getGitHubCopilotModelCapabilities(model: ModelInfo): ModelCapabilities {
  const reasoningEfforts =
    model.capabilities.supports.reasoningEffort && model.supportedReasoningEfforts
      ? model.supportedReasoningEfforts
      : [];

  return {
    reasoningEffortLevels: reasoningEfforts.map((value) => {
      const effort: { value: string; label: string; isDefault?: true } = {
        value,
        label: titleCaseReasoningEffort(value),
      };
      if (model.defaultReasoningEffort === value) {
        effort.isDefault = true;
      }
      return effort;
    }),
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

export function toGitHubCopilotServerProviderModel(model: ModelInfo): ServerProviderModel {
  return {
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: getGitHubCopilotModelCapabilities(model),
  };
}

function preferredModelRank(modelId: string): number {
  const index = PREFERRED_MODEL_ORDER.indexOf(modelId as (typeof PREFERRED_MODEL_ORDER)[number]);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function sortGitHubCopilotModels(
  models: ReadonlyArray<ModelInfo>,
): ReadonlyArray<ModelInfo> {
  return models.toSorted((left, right) => {
    const rankDiff = preferredModelRank(left.id) - preferredModelRank(right.id);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return left.name.localeCompare(right.name);
  });
}

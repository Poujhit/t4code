import type {
  GitHubCopilotSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
} from "@t3tools/contracts";
import { Data, Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { type GetAuthStatusResponse } from "@github/copilot-sdk";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { GitHubCopilotProvider } from "../Services/GitHubCopilotProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@t3tools/contracts";
import {
  createGitHubCopilotClient,
  sortGitHubCopilotModels,
  toGitHubCopilotServerProviderModel,
} from "../githubCopilotSdk";

const PROVIDER = "githubCopilot" as const;
const GITHUB_COPILOT_SDK_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

class GitHubCopilotSdkProbeError extends Data.TaggedError("GitHubCopilotSdkProbeError")<{
  readonly detail: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

const runGitHubCopilotCommand = Effect.fn("runGitHubCopilotCommand")(function* (
  args: ReadonlyArray<string>,
) {
  const settingsService = yield* ServerSettingsService;
  const copilotSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.githubCopilot),
  );
  const command = ChildProcess.make(copilotSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
    env: process.env,
  });
  return yield* spawnAndCollect(copilotSettings.binaryPath, command);
});

function toAuth(authStatus: GetAuthStatusResponse): ServerProviderAuth {
  return {
    status: authStatus.isAuthenticated ? "authenticated" : "unauthenticated",
    ...(authStatus.authType ? { type: authStatus.authType } : {}),
    ...(authStatus.login ? { label: authStatus.login } : {}),
  };
}

const probeGitHubCopilotSdk = Effect.fn("probeGitHubCopilotSdk")(function* (input: {
  readonly binaryPath: string;
}) {
  return yield* Effect.tryPromise({
    try: async () => {
      const client = createGitHubCopilotClient({
        binaryPath: input.binaryPath,
        cwd: process.cwd(),
      });

      try {
        await client.start();
        const status = await client.getStatus().catch((error) => {
          throw new Error(
            `GitHub Copilot SDK could not read CLI status: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        const authStatus = await client.getAuthStatus().catch((error) => {
          throw new Error(
            `GitHub Copilot SDK could not read authentication status: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        const models = await client.listModels().catch((error) => {
          throw new Error(
            `GitHub Copilot SDK could not list models: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return {
          version: status.version,
          authStatus,
          models: sortGitHubCopilotModels(models).map(toGitHubCopilotServerProviderModel),
        };
      } finally {
        await client.stop().catch(() => undefined);
      }
    },
    catch: (cause) =>
      new GitHubCopilotSdkProbeError({
        detail:
          cause instanceof Error
            ? cause.message
            : `GitHub Copilot SDK probe failed: ${String(cause)}`,
        cause,
      }),
  });
});

export const checkGitHubCopilotProviderStatus = Effect.fn("checkGitHubCopilotProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.githubCopilot),
    );
    const checkedAt = new Date().toISOString();
    const customModelsOnly = providerModelsFromSettings(
      [],
      PROVIDER,
      copilotSettings.customModels,
      DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
    );

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: customModelsOnly,
        features: {
          supportsConversationRollback: false,
        },
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    const versionProbe = yield* runGitHubCopilotCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const cause = versionProbe.failure;
      const message = isCommandMissingCause(cause)
        ? "GitHub Copilot CLI was not found. Install `copilot` or update the configured binary path."
        : "Could not start the GitHub Copilot CLI.";
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: customModelsOnly,
        features: {
          supportsConversationRollback: false,
        },
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: customModelsOnly,
        features: {
          supportsConversationRollback: false,
        },
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Timed out while checking the GitHub Copilot CLI version.",
        },
      });
    }

    const parsedVersion = parseGenericCliVersion(
      `${versionProbe.success.value.stdout}\n${versionProbe.success.value.stderr}`,
    );
    const sdkProbe = yield* probeGitHubCopilotSdk({
      binaryPath: copilotSettings.binaryPath,
    }).pipe(Effect.timeoutOption(GITHUB_COPILOT_SDK_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(sdkProbe)) {
      const detail =
        sdkProbe.failure instanceof Error ? sdkProbe.failure.message : String(sdkProbe.failure);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: customModelsOnly,
        features: {
          supportsConversationRollback: false,
        },
        probe: {
          installed: true,
          version: parsedVersion,
          status: "warning",
          auth: { status: "unknown" },
          message: `GitHub Copilot is installed, but the SDK probe failed: ${detail}`,
        },
      });
    }

    if (Option.isNone(sdkProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: customModelsOnly,
        features: {
          supportsConversationRollback: false,
        },
        probe: {
          installed: true,
          version: parsedVersion,
          status: "warning",
          auth: { status: "unknown" },
          message:
            "GitHub Copilot is installed, but authentication and model discovery timed out after 15 seconds.",
        },
      });
    }

    const sdkStatus = sdkProbe.success.value;
    const resolvedModels = providerModelsFromSettings(
      sdkStatus.models,
      PROVIDER,
      copilotSettings.customModels,
      DEFAULT_GITHUB_COPILOT_MODEL_CAPABILITIES,
    );

    if (!sdkStatus.authStatus.isAuthenticated) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: resolvedModels,
        features: {
          supportsConversationRollback: false,
        },
        probe: {
          installed: true,
          version: sdkStatus.version ?? parsedVersion,
          status: "error",
          auth: toAuth(sdkStatus.authStatus),
          message:
            sdkStatus.authStatus.statusMessage ??
            "GitHub Copilot CLI is not authenticated. Run `copilot auth login` and try again.",
        },
      });
    }

    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: resolvedModels,
      features: {
        supportsConversationRollback: false,
      },
      probe: {
        installed: true,
        version: sdkStatus.version ?? parsedVersion,
        status: "ready",
        auth: toAuth(sdkStatus.authStatus),
      },
    });
  },
);

export const GitHubCopilotProviderLive = Layer.effect(
  GitHubCopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkGitHubCopilotProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<GitHubCopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.githubCopilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.githubCopilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);

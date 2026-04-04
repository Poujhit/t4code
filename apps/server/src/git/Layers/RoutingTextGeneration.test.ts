import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { TextGenerationError } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { RoutingTextGenerationLive } from "./RoutingTextGeneration.ts";

const RoutingTextGenerationTestLayer = RoutingTextGenerationLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-routing-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(RoutingTextGenerationTestLayer)("RoutingTextGenerationLive", (it) => {
  it.effect("returns a typed error for unsupported GitHub Copilot git text generation", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;
      const result = yield* Effect.result(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/github-copilot",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-4.1",
          },
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, TextGenerationError);
        assert.equal(
          result.failure.detail,
          "GitHub Copilot does not support Git text generation yet.",
        );
      }
    }),
  );
});

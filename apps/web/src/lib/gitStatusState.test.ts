import { GitManagerError, type GitStatusResult } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGitStatusSnapshot,
  resetGitStatusStateForTests,
  refreshGitStatus,
  watchGitStatus,
} from "./gitStatusState";

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const gitStatusListeners = new Set<(event: GitStatusResult) => void>();

const BASE_STATUS: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/push-status",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const gitClient = {
  refreshStatus: vi.fn(async (input: { cwd: string }) => ({
    ...BASE_STATUS,
    branch: `${input.cwd}-refreshed`,
  })),
  onStatus: vi.fn((input: { cwd: string }, listener: (event: GitStatusResult) => void) =>
    registerListener(gitStatusListeners, listener),
  ),
};

function emitGitStatus(event: GitStatusResult) {
  for (const listener of gitStatusListeners) {
    listener(event);
  }
}

afterEach(() => {
  gitStatusListeners.clear();
  gitClient.onStatus.mockClear();
  gitClient.refreshStatus.mockClear();
  resetGitStatusStateForTests();
});

describe("gitStatusState", () => {
  it("starts fresh cwd state in a pending state", () => {
    expect(getGitStatusSnapshot("/fresh")).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });
  });

  it("shares one live subscription per cwd and updates the per-cwd atom snapshot", () => {
    const releaseA = watchGitStatus("/repo", gitClient);
    const releaseB = watchGitStatus("/repo", gitClient);

    expect(gitClient.onStatus).toHaveBeenCalledOnce();
    expect(getGitStatusSnapshot("/repo")).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });

    emitGitStatus(BASE_STATUS);

    expect(getGitStatusSnapshot("/repo")).toEqual({
      data: BASE_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });

    releaseA();
    expect(gitStatusListeners.size).toBe(1);

    releaseB();
    expect(gitStatusListeners.size).toBe(0);
  });

  it("refreshes git status through the unary RPC without restarting the stream", async () => {
    const release = watchGitStatus("/repo", gitClient);

    emitGitStatus(BASE_STATUS);
    const refreshed = await refreshGitStatus("/repo", gitClient);

    expect(gitClient.onStatus).toHaveBeenCalledOnce();
    expect(gitClient.refreshStatus).toHaveBeenCalledWith({ cwd: "/repo" });
    expect(refreshed).toEqual({ ...BASE_STATUS, branch: "/repo-refreshed" });
    expect(getGitStatusSnapshot("/repo")).toEqual({
      data: { ...BASE_STATUS, branch: "/repo-refreshed" },
      error: null,
      cause: null,
      isPending: false,
    });

    release();
  });

  it("stores the refreshed snapshot even before the stream emits a value", async () => {
    watchGitStatus("/repo-fresh", gitClient);

    expect(getGitStatusSnapshot("/repo-fresh")).toEqual({
      data: null,
      error: null,
      cause: null,
      isPending: true,
    });

    const refreshed = await refreshGitStatus("/repo-fresh", gitClient);

    expect(refreshed).toEqual({ ...BASE_STATUS, branch: "/repo-fresh-refreshed" });
    expect(getGitStatusSnapshot("/repo-fresh")).toEqual({
      data: { ...BASE_STATUS, branch: "/repo-fresh-refreshed" },
      error: null,
      cause: null,
      isPending: false,
    });
  });

  it("stores refresh failures so the UI can surface the real git error", async () => {
    const failingClient = {
      ...gitClient,
      refreshStatus: vi.fn(async () => {
        throw new GitManagerError({
          operation: "refreshStatus",
          detail: "ENOENT: no such file or directory",
        });
      }),
    };

    watchGitStatus("/repo-missing", failingClient);

    await expect(refreshGitStatus("/repo-missing", failingClient)).rejects.toMatchObject({
      message: "Git manager failed in refreshStatus: ENOENT: no such file or directory",
    });
    expect(getGitStatusSnapshot("/repo-missing")).toMatchObject({
      data: null,
      error: {
        message: "Git manager failed in refreshStatus: ENOENT: no such file or directory",
      },
      isPending: false,
    });
  });
});

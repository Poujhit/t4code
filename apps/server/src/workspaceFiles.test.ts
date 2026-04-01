import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bufferLooksBinary,
  readWorkspaceFile,
  resolveWorkspaceFilePath,
  WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES,
  WorkspacePathError,
  writeWorkspaceFile,
  WorkspaceFileConflictError,
} from "./workspaceFiles";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolveWorkspaceFilePath", () => {
  it("rejects path escapes outside the workspace root", () => {
    expect(() =>
      resolveWorkspaceFilePath({
        workspaceRoot: "/repo",
        relativePath: "../escape.ts",
      }),
    ).toThrow(WorkspacePathError);
  });
});

describe("bufferLooksBinary", () => {
  it("detects null bytes in the sample", () => {
    expect(bufferLooksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(bufferLooksBinary(Buffer.from("hello", "utf8"))).toBe(false);
  });
});

describe("readWorkspaceFile", () => {
  it("returns binary fallback metadata without file contents", async () => {
    const workspace = makeTempDir("t3code-workspace-binary-");
    fs.writeFileSync(path.join(workspace, "image.bin"), Buffer.from([0x01, 0x00, 0x02]));

    await expect(
      readWorkspaceFile({
        cwd: workspace,
        relativePath: "image.bin",
      }),
    ).resolves.toEqual({
      relativePath: "image.bin",
      contents: "",
      mtimeMs: expect.any(Number),
      sizeBytes: 3,
      isBinary: true,
      isTooLarge: false,
    });
  });

  it("returns too-large fallback metadata without loading full contents", async () => {
    const workspace = makeTempDir("t3code-workspace-large-");
    fs.writeFileSync(
      path.join(workspace, "large.txt"),
      "a".repeat(WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES + 1),
      "utf8",
    );

    await expect(
      readWorkspaceFile({
        cwd: workspace,
        relativePath: "large.txt",
      }),
    ).resolves.toEqual({
      relativePath: "large.txt",
      contents: "",
      mtimeMs: expect.any(Number),
      sizeBytes: WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES + 1,
      isBinary: false,
      isTooLarge: true,
    });
  });
});

describe("writeWorkspaceFile", () => {
  it("rejects stale writes when the on-disk mtime changes", async () => {
    const workspace = makeTempDir("t3code-workspace-conflict-");
    const absolutePath = path.join(workspace, "notes.md");
    fs.writeFileSync(absolutePath, "first\n", "utf8");
    const originalMtimeMs = fs.statSync(absolutePath).mtimeMs;

    fs.writeFileSync(absolutePath, "second\n", "utf8");
    const updatedTime = new Date(originalMtimeMs + 5_000);
    fs.utimesSync(absolutePath, updatedTime, updatedTime);

    await expect(
      writeWorkspaceFile({
        cwd: workspace,
        relativePath: "notes.md",
        contents: "third\n",
        expectedMtimeMs: originalMtimeMs,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileConflictError);
    expect(fs.readFileSync(absolutePath, "utf8")).toBe("second\n");
  });
});

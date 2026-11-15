// Assembling a target's build Dockerfile (add-target-repositories task 8.1).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listTargets } from "@ceh/factory-target";
import { afterEach, describe, expect, it } from "vitest";
import { assembleBuildDockerfile, assembleDockerfileText, dockerBuildArgs, localBuildImage } from "../src/image.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const WORKER = "FROM node AS worker\nRUN true\n\nFROM worker AS build-base\nENV FACTORY_CONTAINER=build\n\nFROM worker\n";
const TARGET = "# vocab\nFROM build-base AS target-build\nENV FACTORY_TARGET=vocab\n";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a target's build Dockerfile", () => {
  it("is the worker Dockerfile with the target's after it", () => {
    const text = assembleDockerfileText("vocab", WORKER, TARGET);
    expect(text.startsWith(WORKER.trimEnd())).toBe(true);
    expect(text.endsWith(TARGET)).toBe(true);
    // The target's stage comes after the base it names.
    expect(text.indexOf("FROM worker AS build-base")).toBeLessThan(text.indexOf("FROM build-base AS target-build"));
  });

  it.each([
    ["another base image", "FROM node:24\nENV FACTORY_TARGET=vocab\n"],
    ["a second stage", `${TARGET}FROM debian AS extra\n`],
    ["a stage of another name", "FROM build-base AS other\nENV FACTORY_TARGET=vocab\n"],
    ["files copied from another image", `${TARGET}COPY --from=alpine /bin/sh /bin/sh\n`],
    ["no FACTORY_TARGET", "FROM build-base AS target-build\n"],
    ["another target's name", "FROM build-base AS target-build\nENV FACTORY_TARGET=other\n"],
  ])("refuses a target Dockerfile with %s", (_what, target) => {
    expect(() => assembleDockerfileText("vocab", WORKER, target)).toThrow("targets/vocab/build.Dockerfile");
  });

  it("is written to .build/ with the worker's .dockerignore next to it", () => {
    const root = mkdtempSync(join(tmpdir(), "ceh-image-"));
    roots.push(root);
    mkdirSync(join(root, "factory/worker"), { recursive: true });
    mkdirSync(join(root, "targets/vocab"), { recursive: true });
    writeFileSync(join(root, "factory/worker/Dockerfile"), WORKER);
    writeFileSync(join(root, "factory/worker/Dockerfile.dockerignore"), "*\n!factory/\n");
    writeFileSync(join(root, "targets/vocab/build.Dockerfile"), TARGET);

    const assembled = assembleBuildDockerfile("vocab", root);

    expect(assembled).toEqual({ file: ".build/vocab.Dockerfile", stage: "target-build" });
    expect(readFileSync(join(root, ".build/vocab.Dockerfile"), "utf8")).toBe(assembleDockerfileText("vocab", WORKER, TARGET));
    expect(readFileSync(join(root, ".build/vocab.Dockerfile.dockerignore"), "utf8")).toBe("*\n!factory/\n");
    expect(() => assembleBuildDockerfile("../vocab", root)).toThrow("not a target name");
  });

  it("assembles for every target in the repository, on the worker Dockerfile's build-base stage", async () => {
    const worker = readFileSync(join(REPO_ROOT, "factory/worker/Dockerfile"), "utf8");
    expect(worker).toContain("FROM worker AS build-base");
    // The base holds no dependency store: the build installs the clone's dependencies online.
    expect(worker).not.toMatch(/pnpm fetch|FACTORY_PNPM_STORE|pnpm-store/);
    // The allowlist lets the target configs into both images.
    expect(readFileSync(join(REPO_ROOT, "factory/worker/Dockerfile.dockerignore"), "utf8").split("\n")).toContain("!targets/");
    for (const name of await listTargets()) {
      const text = assembleDockerfileText(name, worker, readFileSync(join(REPO_ROOT, "targets", name, "build.Dockerfile"), "utf8"));
      expect(text, name).toContain(`ENV FACTORY_TARGET=${name}`);
    }
  });

  it("names the local image after the target, and builds the assembled file's target stage", () => {
    expect(localBuildImage({ name: "vocab" })).toBe("ceh-build-vocab:local");
    expect(dockerBuildArgs({ file: ".build/vocab.Dockerfile", stage: "target-build" }, "ceh-build-vocab:local")).toEqual([
      "build", "--platform", "linux/amd64", "--file", ".build/vocab.Dockerfile", "--target", "target-build", "--tag", "ceh-build-vocab:local", ".",
    ]);
  });
});

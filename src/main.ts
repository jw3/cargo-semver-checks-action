import * as path from "path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as io from "@actions/io";
import * as toolCache from "@actions/tool-cache";
import * as rustCore from "@actions-rs/core";
import * as exec from "@actions/exec";

import {
    getErrorMessage,
    getPlatformMatchingTarget,
    getRustcVersion,
    optionFromList,
    optionIfValueProvided,
} from "./utils";
import { RustdocCache } from "./rustdoc-cache";

declare const process: { env: Record<string, string> };

const CARGO_TARGET_DIR = path.join("semver-checks", "target");

interface CommandOutput {
    stdout: string;
    stderr: string;
    returnCode: number;
}

async function runCommand(command: string, args: string[]): Promise<CommandOutput> {
    return await _runCommand((options) => exec.exec(command, args, options));
}

async function _runCommand(
    cb: (options: exec.ExecOptions) => Promise<number>,
    additionalOptions: Partial<exec.ExecOptions> = {}
): Promise<CommandOutput> {
    let stdout = "";
    let stderr = "";
    const options = {
        listeners: {
            stdout: (data: Buffer) => {
                stdout += data.toString();
            },
            stderr: (data: Buffer) => {
                stderr += data.toString();
            },
        },
        ...additionalOptions,
    };

    const returnCode = await cb(options);

    return { stdout, stderr, returnCode };
}

async function getCheckReleaseArguments(): Promise<string[]> {
    return [
        optionFromList("--package", rustCore.input.getInputList("package")),
        optionFromList("--exclude", rustCore.input.getInputList("exclude")),
        optionIfValueProvided("--manifest-path", rustCore.input.getInput("manifest-path")),
        optionIfValueProvided("--release-type", rustCore.input.getInput("release-type")),
        getFeatureGroup(rustCore.input.getInput("feature-group")),
        optionFromList("--features", rustCore.input.getInputList("features")),
        rustCore.input.getInputBool("verbose") ? ["--verbose"] : [],
        await pr(rustCore.input.getInputBool("pr")),
    ].flat();
}

async function pr(isPullRequest: boolean): Promise<string[]> {
    if (isPullRequest) {
        const currentBranch = process.env["GITHUB_HEAD_REF"];
        const prBranchesFrom = process.env["GITHUB_BASE_REF"];
        await runCommand("git", ["fetch", "origin", `${currentBranch}`]);
        await runCommand("git", ["fetch", "origin", `${prBranchesFrom}`]);

        if (core.isDebug()) {
            core.debug((await runCommand("git", ["branch", "-a"])).stdout);
        }

        // Switch to the branch we want to compare against.

        await runCommand("git", ["switch", "-f", `${currentBranch}`]);

        if (core.isDebug()) {
            core.debug((await runCommand("git", ["log", "--oneline"])).stdout);
        }

        const mergeBase = (
            await runCommand("git", [
                "merge-base",
                `remotes/origin/${currentBranch}`,
                `remotes/origin/${prBranchesFrom}`,
            ])
        ).stdout.trim(); // trim ending newline from command output
        return ["--baseline-rev", mergeBase.trim(), "--json"];
    } else {
        return [];
    }
}

function getFeatureGroup(name = ""): string[] {
    switch (name) {
        case "all-features":
            return ["--all-features"];
        case "default-features":
            return ["--default-features"];
        case "only-explicit-features":
            return ["--only-explicit-features"];
        case "":
            return [];
        default:
            throw new Error(`Unsupported feature group: ${name}`);
    }
}

function getGitHubToken(): string {
    const token = process.env["GITHUB_TOKEN"] || rustCore.input.getInput("github-token");
    if (!token) {
        throw new Error("Querying the GitHub API is possible only if the GitHub token is set.");
    }
    return token;
}

async function getCargoSemverChecksDownloadURL(target: string): Promise<string> {
    const octokit = github.getOctokit(getGitHubToken());

    const getReleaseUrl = await octokit.rest.repos.getLatestRelease({
        owner: "obi1kenobi",
        repo: "cargo-semver-checks",
    });

    const asset = getReleaseUrl.data.assets.find((asset) => {
        return asset["name"].endsWith(`${target}.tar.gz`);
    });

    if (!asset) {
        throw new Error(`Couldn't find a release for target ${target}.`);
    }

    return asset.url;
}

async function installRustUpIfRequested(): Promise<void> {
    const toolchain = rustCore.input.getInput("rust-toolchain") || "stable";
    if (toolchain != "manual") {
        const rustup = await rustCore.RustUp.getOrInstall();
        await rustup.call(["show"]);
        await rustup.setProfile("minimal");
        await rustup.installToolchain(toolchain);

        // Setting the environment variable here affects only processes spawned
        // by this action, so it will not override the default toolchain globally.
        process.env["RUSTUP_TOOLCHAIN"] = toolchain;
    }

    // Disable incremental compilation.
    process.env["CARGO_INCREMENTAL"] ||= "0";

    // Enable colors in the output.
    process.env["CARGO_TERM_COLOR"] ||= "always";

    // Enable sparse checkout for crates.io except for Rust 1.66 and 1.67,
    // on which it is unstable.
    if (!process.env["CARGO_REGISTRIES_CRATES_IO_PROTOCOL"]) {
        const rustcVersion = await getRustcVersion();
        if (!rustcVersion.startsWith("rustc-1.66") && !rustcVersion.startsWith("rustc-1.67")) {
            process.env["CARGO_REGISTRIES_CRATES_IO_PROTOCOL"] = "sparse";
        }
    }
}

async function runCargoSemverChecks(cargo: rustCore.Cargo): Promise<void> {
    // The default location of the target directory varies depending on whether
    // the action is run inside a workspace or on a single crate. We therefore
    // need to set the target directory explicitly.
    process.env["CARGO_TARGET_DIR"] = CARGO_TARGET_DIR;

    const cargoSemverChecksOptions = await getCheckReleaseArguments();

    if (core.isDebug()) {
        core.debug(
            "options passed to cargo-semver-checks: " + JSON.stringify(cargoSemverChecksOptions)
        );
    }

    const { returnCode } = await _runCommand(
        (execOptions) =>
            cargo.call(
                ["semver-checks", "check-release"].concat(cargoSemverChecksOptions),
                execOptions
            ),
        { ignoreReturnCode: true } // ignore the return code so that we can still make a comment then we can fail the workflow
    );

    if (returnCode !== 0) {
        runCommand("echo", ["::error file=src/lib.rs,line=1,col=1::Broke semver!"]);
    }
}

async function installCargoSemverChecksFromPrecompiledBinary(): Promise<void> {
    const url = await getCargoSemverChecksDownloadURL(getPlatformMatchingTarget());

    core.info(`downloading cargo-semver-checks from ${url}`);
    const tarballPath = await toolCache.downloadTool(url, undefined, `token ${getGitHubToken()}`, {
        accept: "application/octet-stream",
    });
    core.info(`extracting ${tarballPath}`);
    const binPath = await toolCache.extractTar(tarballPath, undefined, ["xz"]);

    core.addPath(binPath);
}

async function installCargoSemverChecksUsingCargo(cargo: rustCore.Cargo): Promise<void> {
    await cargo.call(["install", "cargo-semver-checks", "--locked"]);
}

async function installCargoSemverChecks(cargo: rustCore.Cargo): Promise<void> {
    if ((await io.which("cargo-semver-checks")) != "") {
        return;
    }

    core.info("cargo-semver-checks is not installed, installing now...");

    try {
        await installCargoSemverChecksFromPrecompiledBinary();
    } catch (error) {
        core.info("Failed to download precompiled binary of cargo-semver-checks.");
        core.info(`Error: ${getErrorMessage(error)}`);
        core.info("Installing using cargo install...");

        await installCargoSemverChecksUsingCargo(cargo);
    }
}

async function run(): Promise<void> {
    const manifestPath = path.resolve(rustCore.input.getInput("manifest-path") || "./");
    const manifestDir = path.extname(manifestPath) ? path.dirname(manifestPath) : manifestPath;

    await installRustUpIfRequested();

    const cargo = await rustCore.Cargo.get();

    // await installCargoSemverChecks(cargo);
    await runCommand("git", ["clone", "https://github.com/u9g/cargo-semver-checks"]);
    await runCommand("cd", ["cargo-semver-checks"]);
    await runCommand("git", ["switch", "-f", "output-json"]);
    await runCommand("cargo", ["install", "--path", "."]);
    await runCommand("cd", [".."]);
    await runCommand("rm", ["rm", "-rf", "cargo-semver-checks"]);

    const cache = new RustdocCache(
        cargo,
        path.join(CARGO_TARGET_DIR, "semver-checks", "cache"),
        manifestDir
    );

    await cache.restore();
    await runCargoSemverChecks(cargo);
    await cache.save();
}

async function main() {
    try {
        await run();
    } catch (error) {
        core.setFailed(getErrorMessage(error));
    }
}

main();

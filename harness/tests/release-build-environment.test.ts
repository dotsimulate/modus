import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { releaseRustEnvironment } from "../../desktop/rust-path-remap";

const separator = "\u001f";

describe("desktop release build environment", () => {
  test("remaps user, Cargo, Rustup, and checkout paths in both path styles", () => {
    const result = releaseRustEnvironment({
      repositoryDir: "D:\\work tree\\modus",
      environment: {
        USERPROFILE: "C:\\Users\\builder",
        CARGO_ENCODED_RUSTFLAGS: "-Copt-level=2",
      },
    });
    const flags = result.CARGO_ENCODED_RUSTFLAGS!.split(separator);

    expect(flags[0]).toBe("-Copt-level=2");
    expect(flags).toContain("--remap-path-prefix=C:\\Users\\builder=/user");
    expect(flags).toContain("--remap-path-prefix=C:/Users/builder=/user");
    expect(flags).toContain("--remap-path-prefix=C:\\Users\\builder\\.cargo=/cargo");
    expect(flags).toContain("--remap-path-prefix=C:\\Users\\builder\\.rustup=/rustup");
    expect(flags).toContain("--remap-path-prefix=D:\\work tree\\modus=/modus/source");
    expect(flags.at(-1)).toBe("--remap-path-prefix=D:/work tree/modus=/modus/source");
  });

  test("prefers explicit Cargo and Rustup homes", () => {
    const result = releaseRustEnvironment({
      repositoryDir: resolve("repo"),
      environment: {
        HOME: "/home/builder",
        CARGO_HOME: "/cache/cargo",
        RUSTUP_HOME: "/cache/rustup",
      },
    });

    expect(result.CARGO_ENCODED_RUSTFLAGS).toContain(
      `--remap-path-prefix=${resolve("/cache/cargo")}=/cargo`,
    );
    expect(result.CARGO_ENCODED_RUSTFLAGS).toContain(
      `--remap-path-prefix=${resolve("/cache/rustup")}=/rustup`,
    );
  });

  test("rejects lower-priority Rust flag variables instead of silently overriding them", () => {
    expect(() => releaseRustEnvironment({
      repositoryDir: resolve("repo"),
      environment: { RUSTFLAGS: "-C target-cpu=native" },
    })).toThrow("unset RUSTFLAGS");
  });
});

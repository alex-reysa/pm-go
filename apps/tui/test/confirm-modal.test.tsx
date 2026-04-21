import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "../src/components/confirm-modal.js";

async function tick(ms = 15): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("ConfirmModal", () => {
  it("renders the message + default key hints", async () => {
    const { lastFrame, unmount } = render(
      <ConfirmModal
        message="Run task 't-1' in phase 'Phase 0'?"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Confirm");
    expect(frame).toContain("Run task 't-1'");
    expect(frame).toContain("y/enter confirm");
    expect(frame).toContain("n/esc cancel");
    unmount();
  });

  it("invokes onConfirm on y + on enter", async () => {
    const onConfirm = vi.fn();
    const { stdin, rerender, unmount } = render(
      <ConfirmModal
        message="x"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    await tick();
    stdin.write("y");
    await tick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(
      <ConfirmModal
        message="x"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    await tick();
    stdin.write("\r");
    await tick();
    expect(onConfirm).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("invokes onCancel on n + on esc", async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <ConfirmModal
        message="x"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    await tick();
    stdin.write("n");
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    stdin.write("\u001B");
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("suppresses y/n while busy + shows spinner label", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <ConfirmModal
        message="x"
        busy
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("working");
    stdin.write("y");
    stdin.write("n");
    await tick();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it("renders an error message when provided", async () => {
    const { lastFrame, unmount } = render(
      <ConfirmModal
        message="x"
        error="HTTP 409: phase is pending"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("HTTP 409: phase is pending");
    unmount();
  });
});

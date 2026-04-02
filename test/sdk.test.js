import test from "node:test";
import assert from "node:assert/strict";

import { createTermhubClient, getPlatformCapabilities, TermhubSDKError } from "../src/sdk/index.js";

test("sdk exposes factory and platform capabilities", () => {
  const client = createTermhubClient();
  const capabilities = getPlatformCapabilities();

  assert.equal(typeof client.list, "function");
  assert.equal(typeof client.open, "function");
  assert.equal(typeof client.find, "function");
  assert.equal(typeof client.press, "function");
  assert.equal(typeof client.mouseClick, "function");
  assert.equal(capabilities.platform, process.platform);
  assert.equal(Array.isArray(capabilities.apps), true);
});

test("sdk send validates required text before terminal lookup", async () => {
  const client = createTermhubClient();

  await assert.rejects(
    () => client.send({ session: "demo" }),
    (error) =>
      error instanceof TermhubSDKError &&
      error.code === "ERR_SDK_USAGE" &&
      /text must be a non-empty string/.test(error.message),
  );
});

test("sdk press validates mutually exclusive press modes", async () => {
  const client = createTermhubClient();

  await assert.rejects(
    () => client.press({ session: "demo" }),
    (error) =>
      error instanceof TermhubSDKError &&
      error.code === "ERR_SDK_USAGE" &&
      /requires exactly one of key, combo, or sequence/.test(error.message),
  );
});

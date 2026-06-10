import { expect, test } from "bun:test";
import { fromRelayMessage, toRelayMessage } from "./relay-runtime";

test("relay serialization round-trip keeps the file-end digest", () => {
  const fileEnd = {
    type: "file-end" as const,
    fileId: "file-1",
    bytes: 5,
    digest: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
  };

  expect(fromRelayMessage(toRelayMessage(fileEnd))).toEqual(fileEnd);
});

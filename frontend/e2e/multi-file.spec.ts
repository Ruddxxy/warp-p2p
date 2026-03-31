import { test, expect } from "@playwright/test";
import {
  createPeerPair,
  closePeerPair,
  selectFiles,
  extractRoomCode,
  enterRoomCode,
  waitForTransferComplete,
  createTestFileBuffer,
} from "./helpers";

test.describe("Multi-File Batch Transfer", () => {
  test("transfers multiple files sequentially", async ({ browser }) => {
    const { sender, receiver, senderContext, receiverContext } =
      await createPeerPair(browser);

    try {
      await sender.goto("/");
      await receiver.goto("/");

      // Sender: select 3 files
      await selectFiles(sender, [
        {
          name: "file-a.txt",
          mimeType: "text/plain",
          buffer: createTestFileBuffer(1024, 1),
        },
        {
          name: "file-b.txt",
          mimeType: "text/plain",
          buffer: createTestFileBuffer(2048, 2),
        },
        {
          name: "file-c.txt",
          mimeType: "text/plain",
          buffer: createTestFileBuffer(512, 3),
        },
      ]);

      // Sender: verify batch summary shows "3 files"
      await expect(sender.locator("text=3 files")).toBeVisible({
        timeout: 30_000,
      });

      // Sender: wait for room code
      const code = await extractRoomCode(sender);
      expect(code).toMatch(/^\d{3}-\d{3}$/);

      // Receiver: enter code
      await enterRoomCode(receiver, code);

      // Both: wait for completion
      await waitForTransferComplete(sender);
      await waitForTransferComplete(receiver);

      // Verify batch completion messages
      await expect(sender.locator("text=3 files sent!")).toBeVisible();
      await expect(receiver.locator("text=3 files saved!")).toBeVisible();
    } finally {
      await closePeerPair(senderContext, receiverContext);
    }
  });

  test("single file works as batch of 1", async ({ browser }) => {
    const { sender, receiver, senderContext, receiverContext } =
      await createPeerPair(browser);

    try {
      await sender.goto("/");
      await receiver.goto("/");

      // Select single file — should still work (backward compat)
      await selectFiles(sender, [
        {
          name: "solo.txt",
          mimeType: "text/plain",
          buffer: createTestFileBuffer(256),
        },
      ]);

      const code = await extractRoomCode(sender);
      await enterRoomCode(receiver, code);

      await waitForTransferComplete(sender);
      await waitForTransferComplete(receiver);

      // Single file completion message (not batch)
      await expect(
        sender.locator("text=File sent successfully!"),
      ).toBeVisible();
    } finally {
      await closePeerPair(senderContext, receiverContext);
    }
  });
});

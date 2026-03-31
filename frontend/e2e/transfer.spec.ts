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

test.describe("Single File Transfer", () => {
  test("transfers a file end-to-end between sender and receiver", async ({
    browser,
  }) => {
    const { sender, receiver, senderContext, receiverContext } =
      await createPeerPair(browser);

    try {
      // Both open the app
      await sender.goto("/");
      await receiver.goto("/");

      // Sender: verify landing page
      await expect(sender.locator("text=Send files, instantly")).toBeVisible();

      // Sender: select a file
      const content = createTestFileBuffer(1024); // 1KB test file
      await selectFiles(sender, [
        { name: "test-file.txt", mimeType: "text/plain", buffer: content },
      ]);

      // Sender: wait for room code
      const code = await extractRoomCode(sender);
      expect(code).toMatch(/^\d{3}-\d{3}$/);

      // Receiver: enter the code
      await enterRoomCode(receiver, code);

      // Both: wait for transfer to complete
      await waitForTransferComplete(sender);
      await waitForTransferComplete(receiver);

      // Sender: verify completion message
      await expect(
        sender.locator("text=File sent successfully!"),
      ).toBeVisible();

      // Receiver: verify completion message
      await expect(receiver.locator("text=File saved!")).toBeVisible();
    } finally {
      await closePeerPair(senderContext, receiverContext);
    }
  });

  test("cancel returns to landing screen", async ({ page }) => {
    await page.goto("/");

    // Select a file
    const content = createTestFileBuffer(512);
    await selectFiles(page, [
      { name: "cancel-test.txt", mimeType: "text/plain", buffer: content },
    ]);

    // Wait for send screen (code display)
    await page.waitForSelector('[aria-label^="Transfer code:"]', {
      timeout: 30_000,
    });

    // Small delay to ensure state settled after room creation
    await page.waitForTimeout(500);

    // Click cancel button
    await page.getByRole("button", { name: "Cancel" }).click();

    // Verify back on landing (allow time for animation)
    await expect(page.locator("text=Send files, instantly")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("receiver back button returns to landing", async ({ page }) => {
    await page.goto("/");

    // Click "I have a code"
    await page.click("text=I have a code");

    // Verify code input screen
    await expect(page.locator("text=Enter code")).toBeVisible();

    // Click back
    await page.click("text=Back");

    // Verify back on landing
    await expect(page.locator("text=Send files, instantly")).toBeVisible();
  });
});

import { test, expect } from "@playwright/test";
import {
  createPeerPair,
  closePeerPair,
  selectFiles,
  extractRoomCode,
  createTestFileBuffer,
} from "./helpers";

test.describe("Error Handling", () => {
  test("receiver back button returns to landing", async ({ page }) => {
    await page.goto("/");

    await page.click("text=I have a code");
    await expect(page.locator("text=Enter code")).toBeVisible();

    await page.click("text=Back");
    await expect(page.locator("text=Send files, instantly")).toBeVisible();
  });

  test("offline indicator appears when network drops", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(page.locator("text=Send files, instantly")).toBeVisible();

    // Go offline
    await context.setOffline(true);
    await expect(page.locator("text=You are offline")).toBeVisible({
      timeout: 5_000,
    });

    // Go back online
    await context.setOffline(false);
    await expect(page.locator("text=You are offline")).not.toBeVisible({
      timeout: 5_000,
    });
  });

  test("sender disconnect during setup shows error on receiver", async ({
    browser,
  }) => {
    const { sender, receiver, senderContext, receiverContext } =
      await createPeerPair(browser);

    try {
      await sender.goto("/");
      await receiver.goto("/");

      // Sender: select file and get code
      await selectFiles(sender, [
        {
          name: "disconnect-test.txt",
          mimeType: "text/plain",
          buffer: createTestFileBuffer(1024),
        },
      ]);

      const code = await extractRoomCode(sender);

      // Receiver: enter code
      await receiver.click("text=I have a code");
      const digits = code.replace("-", "");
      for (let i = 0; i < digits.length; i++) {
        await receiver
          .locator(`[aria-label="Digit ${i + 1} of 6"]`)
          .fill(digits[i]);
      }

      // Wait briefly for connection attempt to start
      await receiver.waitForTimeout(2000);

      // Sender: close browser (simulates disconnect)
      await senderContext.close();

      // Receiver: should eventually see an error (peer disconnected or timeout)
      // The error appears either as a toast ([role="alert"]) or as text change
      // Wait up to 35s (WebRTC connection timeout is 30s)
      await expect(receiver.locator('[role="alert"]').first()).toBeVisible({
        timeout: 35_000,
      });
    } finally {
      // senderContext already closed, only close receiver
      await receiverContext.close();
    }
  });

  test("landing page renders correctly", async ({ page }) => {
    await page.goto("/");

    // Verify all key elements are present
    await expect(page.locator("text=Send files, instantly")).toBeVisible();
    await expect(
      page.locator("text=Peer-to-peer. Encrypted. No signup."),
    ).toBeVisible();
    await expect(
      page.locator('[aria-label="Drop files here or click to browse"]'),
    ).toBeVisible();
    await expect(page.locator("text=I have a code")).toBeVisible();
    await expect(page.locator("text=E2E Encrypted")).toBeVisible();
    await expect(page.locator("text=warp")).toBeVisible();
  });
});

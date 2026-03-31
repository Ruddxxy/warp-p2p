import { type Page, type Browser, type BrowserContext } from "@playwright/test";

/**
 * Create a sender+receiver page pair for transfer tests.
 * Returns two independent browser contexts with separate pages.
 */
export async function createPeerPair(browser: Browser) {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext({ acceptDownloads: true });

  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();

  return { sender, receiver, senderContext, receiverContext };
}

/**
 * Clean up a peer pair's contexts.
 */
export async function closePeerPair(
  senderContext: BrowserContext,
  receiverContext: BrowserContext,
) {
  await senderContext.close();
  await receiverContext.close();
}

/**
 * Select files on the sender page via the DropZone file chooser.
 */
export async function selectFiles(
  page: Page,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
) {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.click('[aria-label="Drop files here or click to browse"]');
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(files);
}

/**
 * Extract the room code from the sender's CodeDisplay.
 * Waits for the code to appear (non-empty), then reads the text.
 */
export async function extractRoomCode(page: Page): Promise<string> {
  // Wait for the code display to contain an actual code (not empty)
  // The aria-label format is "Transfer code: XXX-XXX"
  const codeLocator = page.locator('[aria-label*="Transfer code:"]');
  await codeLocator.waitFor({ state: "visible", timeout: 30_000 });

  // Wait until aria-label contains a real code (digits + dash)
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[aria-label*="Transfer code:"]');
      const label = el?.getAttribute("aria-label") ?? "";
      return /\d{3}-\d{3}/.test(label);
    },
    { timeout: 30_000 },
  );

  const label = await codeLocator.getAttribute("aria-label");
  const match = label?.match(/(\d{3}-\d{3})/);
  return match?.[1] ?? "";
}

/**
 * Enter a room code on the receiver's CodeInput page.
 * Types each digit into the individual input boxes.
 */
export async function enterRoomCode(page: Page, code: string) {
  // Click "I have a code" first
  await page.click("text=I have a code");

  // Strip dash from code (e.g. "471-829" → "471829")
  const digits = code.replace("-", "");

  // Type each digit into the corresponding input
  for (let i = 0; i < digits.length; i++) {
    const input = page.locator(`[aria-label="Digit ${i + 1} of 6"]`);
    await input.fill(digits[i]);
  }
}

/**
 * Wait for transfer to complete on a page.
 * Looks for the "Transfer complete" status text.
 */
export async function waitForTransferComplete(page: Page, timeout = 45_000) {
  await page.waitForFunction(
    () => document.body.textContent?.includes("Transfer complete"),
    { timeout },
  );
}

/**
 * Wait for the transfer screen to appear (progress bar visible).
 */
export async function waitForTransferScreen(page: Page, timeout = 30_000) {
  await page.waitForSelector('[role="progressbar"]', { timeout });
}

/**
 * Create a test file buffer with deterministic content.
 */
export function createTestFileBuffer(sizeBytes: number, seed = 0): Buffer {
  const buffer = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    buffer[i] = (i + seed) % 256;
  }
  return buffer;
}

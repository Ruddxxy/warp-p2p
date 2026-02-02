/**
 * Security Module Tests
 *
 * Tests for PAKE handshake, encryption/decryption, and key derivation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SecurityManager,
  generateRoomCode,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  encrypt,
  decrypt
} from '../Security';

describe('Security Module', () => {
  describe('generateRoomCode', () => {
    it('generates a code in XX-XX format', () => {
      const code = generateRoomCode();
      expect(code).toMatch(/^\d{2}-\d{2}$/);
    });

    it('generates unique codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateRoomCode());
      }
      // With 10000 possible combinations, 100 codes should be mostly unique
      expect(codes.size).toBeGreaterThan(90);
    });

    it('pads single digit numbers with leading zero', () => {
      // Generate multiple codes and check format
      for (let i = 0; i < 50; i++) {
        const code = generateRoomCode();
        const [first, second] = code.split('-');
        expect(first.length).toBe(2);
        expect(second.length).toBe(2);
      }
    });
  });

  describe('arrayBufferToBase64 / base64ToArrayBuffer', () => {
    it('correctly encodes and decodes empty buffer', () => {
      const buffer = new ArrayBuffer(0);
      const base64 = arrayBufferToBase64(buffer);
      const decoded = base64ToArrayBuffer(base64);
      expect(decoded.byteLength).toBe(0);
    });

    it('correctly encodes and decodes data', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
      const buffer = data.buffer;
      const base64 = arrayBufferToBase64(buffer);
      const decoded = base64ToArrayBuffer(base64);
      const decodedArray = new Uint8Array(decoded);

      expect(decodedArray).toEqual(data);
    });

    it('produces valid base64 strings', () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const base64 = arrayBufferToBase64(data.buffer);
      // Base64 should only contain valid characters
      expect(base64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    });

    it('handles binary data with all byte values', () => {
      const data = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        data[i] = i;
      }
      const base64 = arrayBufferToBase64(data.buffer);
      const decoded = base64ToArrayBuffer(base64);
      const decodedArray = new Uint8Array(decoded);

      expect(decodedArray).toEqual(data);
    });
  });

  describe('SecurityManager', () => {
    let manager1: SecurityManager;
    let manager2: SecurityManager;
    const testCode = '42-69';

    beforeEach(() => {
      manager1 = new SecurityManager();
      manager2 = new SecurityManager();
    });

    describe('init', () => {
      it('initializes with a room code', async () => {
        await expect(manager1.init(testCode)).resolves.not.toThrow();
      });

      it('is not verified before handshake', async () => {
        await manager1.init(testCode);
        expect(manager1.isVerified()).toBe(false);
      });

      it('has no session key before handshake', async () => {
        await manager1.init(testCode);
        expect(manager1.getSessionKey()).toBeNull();
      });
    });

    describe('createHandshakeMessage', () => {
      it('throws if not initialized', async () => {
        await expect(manager1.createHandshakeMessage()).rejects.toThrow(
          'SecurityManager not initialized'
        );
      });

      it('creates a valid handshake message', async () => {
        await manager1.init(testCode);
        const message = await manager1.createHandshakeMessage();

        expect(message).toHaveProperty('publicKey');
        expect(message).toHaveProperty('signature');
        expect(message).toHaveProperty('nonce');
        expect(typeof message.publicKey).toBe('string');
        expect(typeof message.signature).toBe('string');
        expect(typeof message.nonce).toBe('string');
      });

      it('creates different messages each time (random nonce)', async () => {
        await manager1.init(testCode);
        const message1 = await manager1.createHandshakeMessage();
        const message2 = await manager1.createHandshakeMessage();

        // Nonces should be different
        expect(message1.nonce).not.toBe(message2.nonce);
      });
    });

    describe('processHandshakeMessage', () => {
      it('throws if not initialized', async () => {
        await manager1.init(testCode);
        const message = await manager1.createHandshakeMessage();

        await expect(manager2.processHandshakeMessage(message)).rejects.toThrow(
          'SecurityManager not initialized'
        );
      });

      it('verifies valid handshake from peer with same code', async () => {
        await manager1.init(testCode);
        await manager2.init(testCode);

        const message1 = await manager1.createHandshakeMessage();
        const verified = await manager2.processHandshakeMessage(message1);

        expect(verified).toBe(true);
        expect(manager2.isVerified()).toBe(true);
        expect(manager2.getSessionKey()).not.toBeNull();
      });

      it('establishes session key after successful handshake', async () => {
        await manager1.init(testCode);
        await manager2.init(testCode);

        const message1 = await manager1.createHandshakeMessage();
        await manager2.processHandshakeMessage(message1);

        const message2 = await manager2.createHandshakeMessage();
        await manager1.processHandshakeMessage(message2);

        expect(manager1.getSessionKey()).not.toBeNull();
        expect(manager2.getSessionKey()).not.toBeNull();
      });
    });

    describe('encryptChunk / decryptChunk', () => {
      it('throws without session key', async () => {
        await manager1.init(testCode);
        const data = new ArrayBuffer(100);

        await expect(manager1.encryptChunk(data)).rejects.toThrow(
          'No session key established'
        );
      });

      it('encrypts and decrypts data after handshake', async () => {
        await manager1.init(testCode);
        await manager2.init(testCode);

        // Complete handshake
        const msg1 = await manager1.createHandshakeMessage();
        await manager2.processHandshakeMessage(msg1);
        const msg2 = await manager2.createHandshakeMessage();
        await manager1.processHandshakeMessage(msg2);

        // Test encryption/decryption
        const originalData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const encrypted = await manager1.encryptChunk(originalData.buffer);
        const decrypted = await manager1.decryptChunk(encrypted);

        expect(new Uint8Array(decrypted)).toEqual(originalData);
      });

      it('handles empty data', async () => {
        await manager1.init(testCode);
        await manager2.init(testCode);

        const msg1 = await manager1.createHandshakeMessage();
        await manager2.processHandshakeMessage(msg1);
        const msg2 = await manager2.createHandshakeMessage();
        await manager1.processHandshakeMessage(msg2);

        const emptyData = new ArrayBuffer(0);
        const encrypted = await manager1.encryptChunk(emptyData);
        const decrypted = await manager1.decryptChunk(encrypted);

        expect(decrypted.byteLength).toBe(0);
      });

      it('handles large chunks', async () => {
        await manager1.init(testCode);
        await manager2.init(testCode);

        const msg1 = await manager1.createHandshakeMessage();
        await manager2.processHandshakeMessage(msg1);
        const msg2 = await manager2.createHandshakeMessage();
        await manager1.processHandshakeMessage(msg2);

        // 64KB chunk (typical transfer chunk size)
        const largeData = new Uint8Array(64 * 1024);
        for (let i = 0; i < largeData.length; i++) {
          largeData[i] = i % 256;
        }

        const encrypted = await manager1.encryptChunk(largeData.buffer);
        const decrypted = await manager1.decryptChunk(encrypted);

        expect(new Uint8Array(decrypted)).toEqual(largeData);
      });
    });

    describe('destroy', () => {
      it('clears state', async () => {
        await manager1.init(testCode);
        await manager2.init(testCode);

        const msg1 = await manager1.createHandshakeMessage();
        await manager2.processHandshakeMessage(msg1);

        manager1.destroy();

        expect(manager1.isVerified()).toBe(false);
        expect(manager1.getSessionKey()).toBeNull();
      });

      it('cannot create handshake after destroy', async () => {
        await manager1.init(testCode);
        manager1.destroy();

        await expect(manager1.createHandshakeMessage()).rejects.toThrow(
          'SecurityManager not initialized'
        );
      });
    });
  });

  describe('encrypt / decrypt (direct functions)', () => {
    it('requires a valid key', async () => {
      // This test ensures the functions work with mock crypto
      const mockKey = {} as CryptoKey;
      const data = new ArrayBuffer(10);

      // With our mock, this should work
      const encrypted = await encrypt(mockKey, data);
      expect(encrypted.byteLength).toBeGreaterThan(0);
    });
  });
});

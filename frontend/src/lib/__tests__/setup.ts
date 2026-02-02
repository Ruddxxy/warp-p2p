/**
 * Test setup for Vitest
 * Configures global mocks and polyfills for browser APIs
 */

import { vi } from 'vitest';

// Mock crypto.subtle for tests (jsdom doesn't include full Web Crypto API)
const mockCryptoKey = {
  type: 'secret',
  extractable: true,
  algorithm: { name: 'AES-GCM', length: 256 },
  usages: ['encrypt', 'decrypt']
} as CryptoKey;

const mockKeyPair = {
  publicKey: mockCryptoKey,
  privateKey: mockCryptoKey
} as CryptoKeyPair;

// Mock crypto.subtle for tests (jsdom's implementation doesn't support mock keys)
const subtle = {
  generateKey: vi.fn().mockResolvedValue(mockKeyPair),
  importKey: vi.fn().mockResolvedValue(mockCryptoKey),
  exportKey: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
  deriveKey: vi.fn().mockResolvedValue(mockCryptoKey),
  deriveBits: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
  encrypt: vi.fn().mockImplementation(async (_algo, _key, data) => {
    // Return data with 12-byte IV prepended (simulating AES-GCM)
    const iv = new Uint8Array(12);
    const dataArray = new Uint8Array(data);
    const result = new Uint8Array(iv.length + dataArray.length);
    result.set(iv, 0);
    result.set(dataArray, iv.length);
    return result.buffer;
  }),
  decrypt: vi.fn().mockImplementation(async (_algo, _key, data) => {
    // Skip 12-byte IV and return rest
    const dataArray = new Uint8Array(data);
    return dataArray.slice(12).buffer;
  }),
  sign: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
  verify: vi.fn().mockResolvedValue(true),
  digest: vi.fn().mockImplementation(async (_algo, data) => {
    // Return a mock hash
    const hash = new Uint8Array(32);
    const dataArray = new Uint8Array(data);
    // Simple mock: fill hash based on data length
    for (let i = 0; i < 32; i++) {
      hash[i] = (dataArray[i % dataArray.length] ?? i) ^ i;
    }
    return hash.buffer;
  })
};

Object.defineProperty(globalThis, 'crypto', {
  value: {
    subtle,
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array && 'length' in array) {
        const arr = array as unknown as Uint8Array;
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
      }
      return array;
    }
  },
  writable: true
});

// Mock navigator.vibrate
Object.defineProperty(navigator, 'vibrate', {
  value: vi.fn().mockReturnValue(true),
  writable: true
});

// Mock navigator.onLine
Object.defineProperty(navigator, 'onLine', {
  value: true,
  writable: true
});

// Mock localStorage
const localStorageMock = {
  store: {} as Record<string, string>,
  getItem: vi.fn((key: string) => localStorageMock.store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageMock.store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageMock.store[key];
  }),
  clear: vi.fn(() => {
    localStorageMock.store = {};
  })
};

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true
});

// Reset mocks between tests
beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

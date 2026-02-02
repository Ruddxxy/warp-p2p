/**
 * Security module implementing PAKE (Password Authenticated Key Exchange)
 * Uses Web Crypto API for all cryptographic operations
 *
 * Flow:
 * 1. Both peers derive a shared key from the room code
 * 2. Each peer generates an ephemeral ECDH keypair
 * 3. Public keys are exchanged and verified using the shared code-derived key
 * 4. Final session key is derived from ECDH + code verification
 */

// Generate a random room code (e.g., "74-29")
export function generateRoomCode(): string {
  const array = new Uint8Array(4);
  crypto.getRandomValues(array);
  const num1 = (array[0] << 8 | array[1]) % 100;
  const num2 = (array[2] << 8 | array[3]) % 100;
  return `${num1.toString().padStart(2, '0')}-${num2.toString().padStart(2, '0')}`;
}

// Derive a key from the room code using PBKDF2
async function deriveKeyFromCode(code: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const codeData = encoder.encode(code);

  // Import code as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    codeData,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  // Use a fixed salt for code derivation (both peers will derive the same key)
  const salt = encoder.encode('warp-lan-v1-salt');

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// Generate ephemeral ECDH keypair
async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    ['deriveBits']
  );
}

// Export public key to raw bytes
async function exportPublicKey(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', key);
}

// Import peer's public key
async function importPublicKey(rawKey: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    []
  );
}

// Derive shared secret from ECDH
async function deriveSharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: publicKey
    },
    privateKey,
    256
  );
}

// Encrypt data with AES-GCM
export async function encrypt(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  // Prepend IV to ciphertext
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return result.buffer;
}

// Decrypt data with AES-GCM
export async function decrypt(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const dataArray = new Uint8Array(data);
  const iv = dataArray.slice(0, 12);
  const ciphertext = dataArray.slice(12);

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
}

// HMAC for message authentication
async function computeHMAC(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.exportKey('raw', key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', hmacKey, data);
}

// Verify HMAC
async function verifyHMAC(key: CryptoKey, data: ArrayBuffer, signature: ArrayBuffer): Promise<boolean> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.exportKey('raw', key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', hmacKey, signature, data);
}

// Convert ArrayBuffer to base64
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert base64 to ArrayBuffer
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export interface HandshakeState {
  keyPair: CryptoKeyPair;
  codeKey: CryptoKey;
  sessionKey?: CryptoKey;
  verified: boolean;
}

export interface HandshakeMessage {
  publicKey: string;       // Base64 encoded public key
  signature: string;       // Base64 encoded HMAC
  nonce: string;          // Base64 encoded random nonce
}

/**
 * SecurityManager handles the PAKE handshake and session encryption
 */
export class SecurityManager {
  private state: HandshakeState | null = null;

  // Initialize with room code
  async init(code: string): Promise<void> {
    const keyPair = await generateECDHKeyPair();
    const codeKey = await deriveKeyFromCode(code);

    this.state = {
      keyPair,
      codeKey,
      verified: false
    };
  }

  // Generate handshake message to send to peer
  async createHandshakeMessage(): Promise<HandshakeMessage> {
    if (!this.state) throw new Error('SecurityManager not initialized');

    const publicKeyRaw = await exportPublicKey(this.state.keyPair.publicKey);
    const nonce = crypto.getRandomValues(new Uint8Array(16));

    // Create data to sign: publicKey || nonce
    const dataToSign = new Uint8Array(publicKeyRaw.byteLength + nonce.byteLength);
    dataToSign.set(new Uint8Array(publicKeyRaw), 0);
    dataToSign.set(nonce, publicKeyRaw.byteLength);

    const signature = await computeHMAC(this.state.codeKey, dataToSign.buffer);

    return {
      publicKey: arrayBufferToBase64(publicKeyRaw),
      signature: arrayBufferToBase64(signature),
      nonce: arrayBufferToBase64(nonce.buffer)
    };
  }

  // Process peer's handshake message and derive session key
  async processHandshakeMessage(message: HandshakeMessage): Promise<boolean> {
    if (!this.state) throw new Error('SecurityManager not initialized');

    try {
      const peerPublicKeyRaw = base64ToArrayBuffer(message.publicKey);
      const peerNonce = base64ToArrayBuffer(message.nonce);
      const peerSignature = base64ToArrayBuffer(message.signature);

      // Verify signature
      const dataToVerify = new Uint8Array(peerPublicKeyRaw.byteLength + peerNonce.byteLength);
      dataToVerify.set(new Uint8Array(peerPublicKeyRaw), 0);
      dataToVerify.set(new Uint8Array(peerNonce), peerPublicKeyRaw.byteLength);

      const isValid = await verifyHMAC(this.state.codeKey, dataToVerify.buffer, peerSignature);

      if (!isValid) {
        console.error('[Security] Handshake verification failed - wrong code?');
        return false;
      }

      // Derive shared secret
      const peerPublicKey = await importPublicKey(peerPublicKeyRaw);
      const sharedSecret = await deriveSharedSecret(this.state.keyPair.privateKey, peerPublicKey);

      // Derive session key from shared secret
      const sessionKeyMaterial = await crypto.subtle.importKey(
        'raw',
        sharedSecret,
        'HKDF',
        false,
        ['deriveKey']
      );

      this.state.sessionKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          salt: new TextEncoder().encode('warp-lan-session'),
          info: new TextEncoder().encode('encryption'),
          hash: 'SHA-256'
        },
        sessionKeyMaterial,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );

      this.state.verified = true;
      return true;
    } catch (error) {
      console.error('[Security] Handshake processing failed:', error);
      return false;
    }
  }

  // Check if handshake is complete
  isVerified(): boolean {
    return this.state?.verified ?? false;
  }

  // Get session key for data encryption
  getSessionKey(): CryptoKey | null {
    return this.state?.sessionKey ?? null;
  }

  // Encrypt chunk for transfer
  async encryptChunk(data: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.state?.sessionKey) throw new Error('No session key established');
    return encrypt(this.state.sessionKey, data);
  }

  // Decrypt chunk from transfer
  async decryptChunk(data: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.state?.sessionKey) throw new Error('No session key established');
    return decrypt(this.state.sessionKey, data);
  }

  // Clean up
  destroy(): void {
    this.state = null;
  }
}

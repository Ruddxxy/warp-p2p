declare module 'js-sha256' {
  type Message = string | number[] | ArrayBuffer | Uint8Array;

  interface Hasher {
    update(message: Message): Hasher;
    hex(): string;
    toString(): string;
    arrayBuffer(): ArrayBuffer;
    digest(): number[];
    array(): number[];
  }

  interface Hmac {
    (secretKey: Message, message: Message): string;
    create(secretKey: Message): Hasher;
    update(secretKey: Message, message: Message): Hasher;
    hex(secretKey: Message, message: Message): string;
    arrayBuffer(secretKey: Message, message: Message): ArrayBuffer;
    digest(secretKey: Message, message: Message): number[];
    array(secretKey: Message, message: Message): number[];
  }

  interface Hash {
    (message: Message): string;
    create(): Hasher;
    update(message: Message): Hasher;
    hex(message: Message): string;
    arrayBuffer(message: Message): ArrayBuffer;
    digest(message: Message): number[];
    array(message: Message): number[];
    hmac: Hmac;
  }

  export const sha256: Hash;
  export const sha224: Hash;
}

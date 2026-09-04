import { TextDecoder } from "node:util";

export class Utf8Error extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Utf8Error";
  }
}

export class UnicodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnicodeError";
  }
}

/** Decode a byte sequence as UTF-8 without replacing malformed sequences. */
export function decodeUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Utf8Error(`invalid UTF-8 in ${description}`);
  }
}

/** Reject JavaScript strings containing unpaired UTF-16 surrogate code units. */
export function validateUnicodeString(value: unknown, description: string): string {
  if (typeof value !== "string") throw new UnicodeError(`${description} is not a string`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new UnicodeError(`${description} contains an unpaired UTF-16 surrogate`);
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new UnicodeError(`${description} contains an unpaired UTF-16 surrogate`);
    }
  }
  return value;
}

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// Neither built-in fits: Web Crypto is async-only and record() is sync,
// Node's crypto is server-only. Output equals Node's utf-8 hex digest.
export const sha256Hex = (value: string): string => bytesToHex(sha256(utf8ToBytes(value)));

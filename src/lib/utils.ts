import cbor from "cbor";
import { TAG_MAP } from "./config";

export function maybeEncodeValue(key: string, value: any): any {
  // only dates of type 'full-date' need to be tagged as 1004
  const tag = TAG_MAP[key];
  if (!tag) return value;

  if (tag === 1004) return new cbor.Tagged(1004, value);

  throw new Error(`Unknown tag "${tag}"`);
}

// Do all CBOR operations in one spot so we can change libs easily
export async function cborEncode(data: any) {
  return cbor.encode(data);
}
export async function cborTagged(tag: number, data: any) {
  return new cbor.Tagged(tag, data);
}

export async function cborDecode(data: any) {
  const extraTags = {
    24: (value) => cbor.decode(value, { tags: extraTags }),
    1004: (dateString) => dateString,
  };
  return cbor.decode(data, { tags: extraTags });
}

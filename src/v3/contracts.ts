/**
 * v3 contract script building.
 *
 * Radiant ref contracts must be deployed BARE (the code + refs live directly in the
 * scriptPubKey; cashscript's P2SH `.address` would hide them). We build the locking
 * bytecode by substituting the compiled artifact's `$placeholder` constants with hex
 * and serializing with radiantjs `Script.fromASM`, which inlines OP_PUSHINPUTREF*
 * operands as the raw 36-byte operand consensus expects (cashscript's own serializer
 * does not). This mirrors Photonic's ftScript construction and the validated harnesses.
 */
import Radiant from '@radiant-core/radiantjs';
const { Script } = Radiant as any;

export type Hex = string;

/** A Radiant 36-byte reference = internal-LE txid (reverse of display hex) + vout LE(4). */
export function encodeRef(txidDisplay: Hex, vout: number): Buffer {
  const txidLE = Buffer.from(txidDisplay, 'hex').reverse();
  const v = Buffer.alloc(4);
  v.writeUInt32LE(vout >>> 0, 0);
  return Buffer.concat([txidLE, v]);
}

const hx = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('hex');

/** Substitute `$name` constants in a compiled artifact ASM string with hex values. */
export function substituteAsm(asm: string, subs: Record<string, Buffer | string>): string {
  let out = asm;
  for (const [k, v] of Object.entries(subs)) {
    const hex = typeof v === 'string' ? v.replace(/^0x/, '') : hx(v);
    out = out.split(k).join(hex);
  }
  const leftover = out.match(/\$\w+/);
  if (leftover) throw new Error(`unsubstituted placeholder ${leftover[0]} in ASM`);
  return out;
}

/** Build bare locking bytecode from a compiled ASM + constant substitutions. */
export function buildBareCode(asm: string, subs: Record<string, Buffer | string>): Buffer {
  return Buffer.from(Script.fromASM(substituteAsm(asm, subs)).toBuffer());
}

/** Minimal-push encoding of `data` (Bitcoin script pushdata rules). */
export function encodePush(data: Buffer): Buffer {
  const n = data.length;
  if (n < 0x4c) return Buffer.concat([Buffer.from([n]), data]);
  if (n <= 0xff) return Buffer.concat([Buffer.from([0x4c, n]), data]);
  if (n <= 0xffff) { const h = Buffer.alloc(2); h.writeUInt16LE(n, 0); return Buffer.concat([Buffer.from([0x4d]), h, data]); }
  const h = Buffer.alloc(4); h.writeUInt32LE(n, 0); return Buffer.concat([Buffer.from([0x4e]), h, data]);
}

const OP_STATESEPARATOR = 0xbd;

/** A stateful holder UTXO: `<push stateData> OP_STATESEPARATOR <code>`. */
export function buildStatefulOutput(stateData: Buffer, code: Buffer): Buffer {
  return Buffer.concat([encodePush(stateData), Buffer.from([OP_STATESEPARATOR]), code]);
}

export interface PoolArtifacts {
  poolAsm: string;   // RadiantMMPool.json .asm
  tokenAsm: string;  // RadiantMMToken.json .asm
}

/** Build the bare controller + token code for a pool, given its refs and owner. */
export function buildPoolScripts(
  art: PoolArtifacts,
  poolRef: Buffer,
  tokenRef: Buffer,
  ownerPkh: Buffer,
): { controllerCode: Buffer; tokenCode: Buffer } {
  const subs = { '$poolRef': poolRef, '$tokenRef': tokenRef, '$ownerPkh': ownerPkh };
  return {
    controllerCode: buildBareCode(art.poolAsm, subs),
    tokenCode: buildBareCode(art.tokenAsm, { '$tokenRef': tokenRef, '$poolRef': poolRef }),
  };
}

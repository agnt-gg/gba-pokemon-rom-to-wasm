/**
 * Minimal WebAssembly binary (.wasm) encoder.
 *
 * This is a REAL WASM emitter: it produces a valid WebAssembly 1.0 (MVP) module
 * binary that `WebAssembly.compile` / `new WebAssembly.Module()` accepts. No external
 * toolchain (binaryen / wabt / wat2wasm) is required — we hand-encode the LEB128 and
 * section layout.
 *
 * Scope: exactly the subset the ARM->WASM recompiler needs:
 *   - i32 / i64 value types
 *   - imported memory + imported host functions
 *   - locals
 *   - i32 arithmetic / bitwise / shift / compare / select
 *   - i32 loads & stores against the imported memory (the CPU register file)
 *   - calls to imported host functions (guest memory access, block exit)
 *   - structured control flow: block / loop / if / br / br_if / return
 *
 * The module exports one function per recompiled basic block. Each block reads/writes
 * the guest register file from linear memory and returns a "next PC" i32 to the runtime
 * dispatcher.
 */

// ---- value types ----
export const I32 = 0x7f;
export const I64 = 0x7e;
export const F32 = 0x7d;
export const F64 = 0x7c;
export const VOID = 0x40; // empty block type

// ---- opcodes we use ----
export const OP = {
  unreachable: 0x00,
  nop: 0x01,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  return: 0x0f,
  call: 0x10,
  drop: 0x1a,
  select: 0x1b,
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  global_get: 0x23,
  global_set: 0x24,
  i32_load: 0x28,
  i32_load8_u: 0x2d,
  i32_load16_u: 0x2f,
  i32_store: 0x36,
  i32_store8: 0x3a,
  i32_store16: 0x3b,
  i32_const: 0x41,
  i64_const: 0x42,
  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_s: 0x48,
  i32_lt_u: 0x49,
  i32_gt_s: 0x4a,
  i32_gt_u: 0x4b,
  i32_le_s: 0x4c,
  i32_le_u: 0x4d,
  i32_ge_s: 0x4e,
  i32_ge_u: 0x4f,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_div_s: 0x6d,
  i32_div_u: 0x6e,
  i32_rem_s: 0x6f,
  i32_rem_u: 0x70,
  i32_and: 0x71,
  i32_or: 0x72,
  i32_xor: 0x73,
  i32_shl: 0x74,
  i32_shr_s: 0x75,
  i32_shr_u: 0x76,
  i32_rotl: 0x77,
  i32_rotr: 0x78,
  i32_clz: 0x67,
  i32_ctz: 0x68,
  i32_popcnt: 0x69,
  i64_extend_i32_u: 0xad,
  i64_extend_i32_s: 0xac,
  i32_wrap_i64: 0xa7,
  i64_add: 0x7c,
  i64_mul: 0x7e,
  i64_and: 0x83,
  i64_shr_u: 0x88,
  i64_shl: 0x86,
} as const;

// ---- LEB128 ----
export function unsignedLEB(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

export function signedLEB(n: number): number[] {
  const out: number[] = [];
  let more = true;
  // Use BigInt-free signed LEB for 32-bit values.
  let value = n | 0;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

export function signedLEB64(n: bigint): number[] {
  const out: number[] = [];
  let more = true;
  let value = n;
  while (more) {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if ((value === 0n && (byte & 0x40) === 0) || (value === -1n && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

function strBytes(s: string): number[] {
  const enc = new TextEncoder().encode(s);
  return [...unsignedLEB(enc.length), ...enc];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...unsignedLEB(payload.length), ...payload];
}

function vec(items: number[][]): number[] {
  return [...unsignedLEB(items.length), ...items.flat()];
}

/** A function type signature: params -> results. */
export interface FuncType {
  params: number[];
  results: number[];
}

/** An imported host function the recompiled module will call. */
export interface ImportFunc {
  module: string;
  name: string;
  type: FuncType;
}

/** A function body: locals (counts per type) + raw opcode bytes (terminated by `end`). */
export interface FuncBody {
  /** e.g. [{count: 4, type: I32}] */
  locals: { count: number; type: number }[];
  /** raw bytes for the body, NOT including the final 0x0b end (we append it). */
  code: number[];
  /** signature index into the type section. */
  typeIndex: number;
  /** export name (optional). */
  exportName?: string;
}

/**
 * Build a complete WASM module binary.
 *
 * Layout:
 *   magic + version
 *   type section     (1)
 *   import section   (2): imported memory + imported host functions
 *   function section (3): declared local functions (block funcs)
 *   export section   (7): exported block funcs
 *   code section     (10): block func bodies
 */
export function buildModule(opts: {
  types: FuncType[];
  imports: ImportFunc[];
  memory: { module: string; name: string; minPages: number };
  functions: FuncBody[];
}): Uint8Array {
  const { types, imports, memory, functions } = opts;

  // --- type section ---
  const typeEntries = types.map((t) => [
    0x60, // func type
    ...vec(t.params.map((p) => [p])),
    ...vec(t.results.map((r) => [r])),
  ]);
  const typeSec = section(1, vec(typeEntries));

  // --- import section ---
  // memory import first, then function imports.
  const importEntries: number[][] = [];
  importEntries.push([
    ...strBytes(memory.module),
    ...strBytes(memory.name),
    0x02, // memory import
    0x00, // limits: min only
    ...unsignedLEB(memory.minPages),
  ]);
  for (const imp of imports) {
    importEntries.push([
      ...strBytes(imp.module),
      ...strBytes(imp.name),
      0x00, // func import
      ...unsignedLEB(types.indexOf(findType(types, imp.type))),
    ]);
  }
  const importSec = section(2, vec(importEntries));

  // function index space: imports come first, then local functions.
  const importedFuncCount = imports.length;

  // --- function section ---
  const funcSec = section(3, vec(functions.map((f) => unsignedLEB(f.typeIndex))));

  // --- export section ---
  const exportEntries: number[][] = [];
  functions.forEach((f, i) => {
    if (f.exportName) {
      exportEntries.push([
        ...strBytes(f.exportName),
        0x00, // func export
        ...unsignedLEB(importedFuncCount + i),
      ]);
    }
  });
  const exportSec = section(7, vec(exportEntries));

  // --- code section ---
  const codeEntries = functions.map((f) => {
    const localsVec = vec(f.locals.map((l) => [...unsignedLEB(l.count), l.type]));
    const body = [...localsVec, ...f.code, OP.end];
    return [...unsignedLEB(body.length), ...body];
  });
  const codeSec = section(10, vec(codeEntries));

  const bytes = [
    0x00, 0x61, 0x73, 0x6d, // magic "\0asm"
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSec,
    ...importSec,
    ...funcSec,
    ...exportSec,
    ...codeSec,
  ];
  return new Uint8Array(bytes);
}

function findType(types: FuncType[], t: FuncType): FuncType {
  const match = types.find(
    (x) =>
      x.params.length === t.params.length &&
      x.results.length === t.results.length &&
      x.params.every((p, i) => p === t.params[i]) &&
      x.results.every((r, i) => r === t.results[i]),
  );
  if (!match) throw new Error('type not found in type section');
  return match;
}

/**
 * A small fluent emitter to build a function body's opcode stream.
 * Keeps recompiler code readable instead of pushing raw bytes everywhere.
 */
export class CodeBuilder {
  bytes: number[] = [];

  i32_const(n: number): this { this.bytes.push(OP.i32_const, ...signedLEB(n)); return this; }
  i64_const(n: bigint): this { this.bytes.push(OP.i64_const, ...signedLEB64(n)); return this; }
  local_get(i: number): this { this.bytes.push(OP.local_get, ...unsignedLEB(i)); return this; }
  local_set(i: number): this { this.bytes.push(OP.local_set, ...unsignedLEB(i)); return this; }
  local_tee(i: number): this { this.bytes.push(OP.local_tee, ...unsignedLEB(i)); return this; }
  call(funcIndex: number): this { this.bytes.push(OP.call, ...unsignedLEB(funcIndex)); return this; }

  // memory ops against the imported memory (align, offset)
  i32_load(offset = 0, align = 2): this { this.bytes.push(OP.i32_load, align, ...unsignedLEB(offset)); return this; }
  i32_load8_u(offset = 0): this { this.bytes.push(OP.i32_load8_u, 0, ...unsignedLEB(offset)); return this; }
  i32_load16_u(offset = 0): this { this.bytes.push(OP.i32_load16_u, 1, ...unsignedLEB(offset)); return this; }
  i32_store(offset = 0, align = 2): this { this.bytes.push(OP.i32_store, align, ...unsignedLEB(offset)); return this; }
  i32_store8(offset = 0): this { this.bytes.push(OP.i32_store8, 0, ...unsignedLEB(offset)); return this; }
  i32_store16(offset = 0): this { this.bytes.push(OP.i32_store16, 1, ...unsignedLEB(offset)); return this; }

  op(opcode: number): this { this.bytes.push(opcode); return this; }

  // control flow
  block(bt = VOID): this { this.bytes.push(OP.block, bt); return this; }
  loop(bt = VOID): this { this.bytes.push(OP.loop, bt); return this; }
  if_(bt = VOID): this { this.bytes.push(OP.if, bt); return this; }
  else_(): this { this.bytes.push(OP.else); return this; }
  end(): this { this.bytes.push(OP.end); return this; }
  br(depth: number): this { this.bytes.push(OP.br, ...unsignedLEB(depth)); return this; }
  br_if(depth: number): this { this.bytes.push(OP.br_if, ...unsignedLEB(depth)); return this; }
  return_(): this { this.bytes.push(OP.return); return this; }
  drop(): this { this.bytes.push(OP.drop); return this; }

  build(): number[] { return this.bytes; }
}

/**
 * Proves the WASM encoder emits a REAL, instantiable WebAssembly module.
 *
 * If WebAssembly.instantiate() accepts our hand-built bytes and the exported function
 * computes correctly against imported memory + an imported host function, the encoder is
 * a genuine .wasm emitter (not a renamed interpreter).
 */
import { buildModule, CodeBuilder, I32, OP } from '../src/recompiler/wasm_encoder.ts';

let passed = 0, failed = 0;
function test(n: string, f: () => void | Promise<void>) {
  return Promise.resolve()
    .then(f)
    .then(() => { passed++; console.log('ok   - ' + n); })
    .catch((e: any) => { failed++; console.log('FAIL - ' + n + '\n       ' + (e?.message || e)); });
}
function assertEq(a: any, b: any, m: string) { if (a !== b) throw new Error(`${m}: got ${a}, expected ${b}`); }

await test('encoder builds an instantiable module that adds two i32 mem words and calls a host fn', async () => {
  // Type 0: (i32,i32)->i32  (the host import: add+log)
  // Type 1: ()->i32         (the exported block fn)
  const tAddHost = { params: [I32, I32], results: [I32] };
  const tBlock = { params: [], results: [I32] };

  let hostCalledWith: [number, number] | null = null;
  const importObj = {
    env: {
      mem: new WebAssembly.Memory({ initial: 1 }),
      host_add: (a: number, b: number) => { hostCalledWith = [a, b]; return (a + b) | 0; },
    },
  };

  // Pre-seed two register words in linear memory: [0]=40, [4]=2
  const view = new DataView(importObj.env.mem.buffer);
  view.setInt32(0, 40, true);
  view.setInt32(4, 2, true);

  // Block body: load mem[0], load mem[4], call host_add, store to mem[8], return mem[8].
  const cb = new CodeBuilder();
  cb.i32_const(0).i32_load(0);   // push mem[0]
  cb.i32_const(4).i32_load(0);   // push mem[4]
  cb.call(0);                    // host_add(mem[0], mem[4]) -> i32
  cb.i32_const(8);               // address for store... but value must be under address
  // restructure: compute value first, keep in local, then store
  // simpler: store wants (addr, value). We currently have value on stack. Redo cleanly:
  cb.bytes.length = 0;
  cb.i32_const(8);               // addr for store
  cb.i32_const(0).i32_load(0);   // value part A
  cb.i32_const(4).i32_load(0);   // value part B
  cb.call(0);                    // -> sum
  cb.i32_store(0);               // mem[8] = sum
  cb.i32_const(8).i32_load(0);   // push mem[8]
  cb.return_();

  const mod = buildModule({
    types: [tAddHost, tBlock],
    imports: [{ module: 'env', name: 'host_add', type: tAddHost }],
    memory: { module: 'env', name: 'mem', minPages: 1 },
    functions: [{ locals: [], code: cb.build(), typeIndex: 1, exportName: 'block' }],
  });

  const { instance } = await WebAssembly.instantiate(mod, importObj as any);
  const result = (instance.exports.block as Function)();
  assertEq(result, 42, 'exported block return');
  assertEq(view.getInt32(8, true), 42, 'stored sum in memory');
  assertEq(hostCalledWith?.[0], 40, 'host called arg0');
  assertEq(hostCalledWith?.[1], 2, 'host called arg1');
});

await test('encoder supports if/else control flow with i32 result', async () => {
  const tBlock = { params: [I32], results: [I32] };
  const importObj = { env: { mem: new WebAssembly.Memory({ initial: 1 }) } };

  // fn(x) => x > 10 ? 100 : 200
  const cb = new CodeBuilder();
  cb.local_get(0).i32_const(10).op(OP.i32_gt_s);
  cb.if_(I32);
  cb.i32_const(100);
  cb.else_();
  cb.i32_const(200);
  cb.end();
  cb.return_();

  const mod = buildModule({
    types: [tBlock],
    imports: [],
    memory: { module: 'env', name: 'mem', minPages: 1 },
    functions: [{ locals: [], code: cb.build(), typeIndex: 0, exportName: 'pick' }],
  });
  const { instance } = await WebAssembly.instantiate(mod, importObj as any);
  const pick = instance.exports.pick as Function;
  assertEq(pick(50), 100, 'gt branch');
  assertEq(pick(3), 200, 'le branch');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

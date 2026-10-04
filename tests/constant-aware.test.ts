import { describe, expect, it } from 'vitest';
import {
  MAX_STACK_DEPTH,
  decodeInstruction,
  validateJsonText,
  validateProgram,
  type ConstantSlot,
  type StackType,
  type ValidateOptions,
} from '../src/validator';

interface RawInstruction {
  op: string;
  value?: number | boolean;
  target?: number;
}

const program = (instructions: RawInstruction[]) => ({ instructions });

const int = (value = 1): RawInstruction => ({ op: 'PUSH_INT', value });
const bool = (value = true): RawInstruction => ({ op: 'PUSH_BOOL', value });
const add = (): RawInstruction => ({ op: 'ADD' });
const not = (): RawInstruction => ({ op: 'NOT' });
const dup = (): RawInstruction => ({ op: 'DUP' });
const pop = (): RawInstruction => ({ op: 'POP' });
const jump = (target: number): RawInstruction => ({ op: 'JUMP', target });
const jif = (target: number): RawInstruction => ({
  op: 'JUMP_IF_FALSE',
  target,
});
const halt = (): RawInstruction => ({ op: 'HALT' });
const bad = (): RawInstruction => ({ op: 'NOPE' });

const constInt = (value: number): ConstantSlot => ({ type: 'int', value });
const constBool = (value: boolean): ConstantSlot => ({ type: 'bool', value });
const unknownInt = (): ConstantSlot => ({ type: 'int', value: null });
const unknownBool = (): ConstantSlot => ({ type: 'bool', value: null });

function constResult(instructions: RawInstruction[]) {
  const result = validateProgram(program(instructions), { constantAware: true });
  expect(result.kind).toBe('program');
  if (result.kind !== 'program' || !('mode' in result)) {
    throw new Error('unexpected result kind');
  }
  return result;
}

function expectConstValid(instructions: RawInstruction[]) {
  const result = constResult(instructions);
  expect(result.ok, JSON.stringify(result.analysis.issues)).toBe(true);
  return result.analysis;
}

function expectConstInvalidAt(
  pc: number,
  code: string,
  instructions: RawInstruction[]
) {
  const result = constResult(instructions);
  expect(result.ok).toBe(false);
  expect(result.analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
    [pc, code],
  ]);
  return result.analysis.issues[0]!;
}

function defaultAnalysis(instructions: RawInstruction[]) {
  const result = validateProgram(program(instructions));
  if (result.kind !== 'program') {
    throw new Error('unexpected result kind');
  }
  return result.analysis;
}

describe('constant-aware branch pruning', () => {
  it('treats the false branch of a proven-true condition as dead', () => {
    const instructions = [
      bool(true),
      jif(4),
      bool(true),
      halt(),
      bool(false),
      halt(),
    ];
    const analysis = expectConstValid(instructions);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.deadPcs).toEqual([4, 5]);
    expect(analysis.pcSignatures[1]).toEqual([constBool(true)]);
    expect(analysis.pcSignatures[3]).toEqual([constBool(true)]);

    // 默认模式仍然探索两个分支
    const fallback = defaultAnalysis(instructions);
    expect(fallback.reachablePcs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fallback.deadPcs).toEqual([]);
  });

  it('treats the fall-through of a proven-false condition as dead', () => {
    const analysis = expectConstValid([
      bool(false),
      jif(4),
      bool(true),
      halt(),
      bool(false),
      halt(),
    ]);
    expect(analysis.reachablePcs).toEqual([0, 1, 4, 5]);
    expect(analysis.deadPcs).toEqual([2, 3]);
    expect(analysis.pcSignatures[5]).toEqual([constBool(false)]);
  });

  it('tracks constants through arithmetic and comparison', () => {
    const analysis = expectConstValid([
      int(2),
      int(3),
      add(),
      int(5),
      { op: 'EQ' },
      jif(8),
      bool(true),
      halt(),
      bool(false),
      halt(),
    ]);
    // 2 + 3 == 5 可证明为真，PC 7 的 HALT 是唯一出口
    expect(analysis.pcSignatures[5]).toEqual([constBool(true)]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(analysis.deadPcs).toEqual([8, 9]);
  });

  it('does not report an out-of-bounds jump on a proven-dead branch', () => {
    const instructions = [bool(true), jif(99), bool(true), halt()];
    const analysis = expectConstValid(instructions);
    expect(analysis.deadPcs).toEqual([]);

    const fallback = defaultAnalysis(instructions);
    expect(fallback.issues.map((issue) => issue.code)).toEqual([
      'jump_target_out_of_bounds',
    ]);
  });
});

describe('constant-aware merge and re-propagation', () => {
  // 循环体的回边把不同的布尔常量带回循环头：
  // 首次到达 [bool(true)]，回边带来 [bool(false)]，合流后变未知。
  const flippingLoop = [
    bool(true), // 0
    not(), // 1 循环头
    dup(), // 2
    jif(1), // 3 条件未知后两个方向都要探索
    pop(), // 4
    bool(true), // 5
    halt(), // 6
  ];

  it('joins same-type different-constant arrivals into an unknown slot', () => {
    const analysis = expectConstValid(flippingLoop);
    expect(analysis.pcSignatures[1]).toEqual([unknownBool()]);
    expect(analysis.pcSignatures[2]).toEqual([unknownBool()]);
    expect(analysis.pcSignatures[3]).toEqual([unknownBool(), unknownBool()]);
    expect(analysis.pcSignatures[4]).toEqual([unknownBool()]);
    expect(analysis.pcSignatures[6]).toEqual([constBool(true)]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(analysis.deadPcs).toEqual([]);
    expect(analysis.maxStackDepth).toBe(2);
  });

  it('re-explores successors pruned at first arrival once the condition widens', () => {
    // 首次到达 PC 3 时条件可证明为假，只有回边被探索；
    // 合流变未知后必须重新传播，PC 4 的坏指令才会被发现。
    const issue = expectConstInvalidAt(4, 'malformed_instruction', [
      bool(true),
      not(),
      dup(),
      jif(1),
      bad(),
    ]);
    expect(issue.witness.path.map((edgeItem) => edgeItem.type)).toEqual([
      'fall',
      'fall',
      'fall',
      'true_branch',
    ]);
  });

  it('widens an integer loop counter to unknown and keeps a proven-true exit dead', () => {
    const analysis = expectConstValid([
      int(1), // 0
      int(1), // 1 循环头：第一次 [int(1)]，回边 [int(2)]，合流后未知
      add(), // 2
      bool(true), // 3
      jif(6), // 4 条件可证明为真，出口永远不走
      jump(1), // 5
      pop(), // 6
      bool(true), // 7
      halt(), // 8
    ]);
    expect(analysis.pcSignatures[1]).toEqual([unknownInt()]);
    expect(analysis.pcSignatures[2]).toEqual([unknownInt(), constInt(1)]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(analysis.deadPcs).toEqual([6, 7, 8]);
    expect(analysis.maxStackDepth).toBe(2);
  });

  it('still reports a type-sequence merge conflict on a back edge', () => {
    const result = constResult([
      bool(true), // 0
      jif(4), // 1 条件可证明为真，只走落点
      int(1), // 2 回边把一个 int 带回 PC 0
      jump(0), // 3
      halt(), // 4
    ]);
    expect(result.ok).toBe(false);
    expect(result.analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'stack_merge_conflict'],
    ]);
    expect(result.analysis.deadPcs).toEqual([4]);
    const issue = result.analysis.issues[0]!;
    expect(issue.witness.conflicts).toMatchObject({
      existingStack: [],
      incomingStack: [constInt(1)],
    });
  });
});

describe('constant-aware dead code', () => {
  const deadBadProgram = [bool(true), jif(4), bool(true), halt(), bad()];

  it('lists a malformed instruction behind a proven-constant branch as dead', () => {
    const analysis = expectConstValid(deadBadProgram);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.deadPcs).toEqual([4]);
    expect(analysis.issues).toEqual([]);
  });

  it('reports the same malformed instruction in default mode', () => {
    const analysis = defaultAnalysis(deadBadProgram);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [4, 'malformed_instruction'],
    ]);
    expect(analysis.deadPcs).toEqual([]);
  });

  it('still reports a malformed instruction on the taken branch', () => {
    const analysis = constResult([bool(false), jif(3), halt(), bad()]);
    expect(analysis.ok).toBe(false);
    expect(analysis.analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [3, 'malformed_instruction'],
    ]);
    expect(analysis.analysis.deadPcs).toEqual([2]);
  });
});

describe('constant-aware keeps the original rules', () => {
  it('enforces the HALT stack shape with constant evidence in the report', () => {
    const issue = expectConstInvalidAt(1, 'halt_stack_not_boolean', [int(5), halt()]);
    expect(issue.entryStack).toEqual([constInt(5)]);
    expectConstInvalidAt(0, 'halt_stack_size', [halt()]);
  });

  it('enforces type errors and underflow', () => {
    expectConstInvalidAt(1, 'type_error', [int(1), not(), halt()]);
    expectConstInvalidAt(0, 'stack_underflow', [pop(), halt()]);
  });

  it('enforces the stack depth limit', () => {
    const instructions = Array.from({ length: MAX_STACK_DEPTH + 1 }, () => bool(true));
    const issue = expectConstInvalidAt(MAX_STACK_DEPTH, 'stack_overflow', instructions);
    expect(issue.details).toMatchObject({ maxStackDepth: 32, attemptedSize: 33 });
  });

  it('accepts a balanced loop with a stable constant state', () => {
    const analysis = expectConstValid([bool(true), dup(), jif(1), halt()]);
    expect(analysis.pcSignatures[1]).toEqual([constBool(true)]);
    expect(analysis.deadPcs).toEqual([]);
  });
});

describe('default mode compatibility', () => {
  const samples: RawInstruction[][] = [
    [bool(true), halt()],
    [bool(true), jif(4), bool(false), jump(5), bool(true), halt()],
    [bool(true), jif(3), halt(), bad()],
    [jump(1), bool(false), jump(0)],
    [int(1), int(2), add(), halt()],
    [bool(true), jif(99), bool(true), halt()],
    [bool(true), not(), dup(), jif(1), pop(), bool(true), halt()],
  ];

  it('returns field-for-field identical results with or without explicit options', () => {
    for (const instructions of samples) {
      const plain = validateProgram(program(instructions));
      const explicitFalse = validateProgram(program(instructions), {
        constantAware: false,
      });
      const emptyOptions = validateProgram(program(instructions), {});
      expect(explicitFalse).toEqual(plain);
      expect(emptyOptions).toEqual(plain);

      const text = JSON.stringify(program(instructions));
      expect(validateJsonText(text)).toEqual(plain);
      expect(validateJsonText(text, { constantAware: false })).toEqual(plain);
    }
  });

  it('never adds the constant-aware mode marker to default reports', () => {
    for (const instructions of samples) {
      const result = validateProgram(program(instructions));
      expect(result).not.toHaveProperty('mode');
    }
  });
});

describe('invalid mode options are rejected wholesale', () => {
  const validProgram = program([bool(true), halt()]);

  function expectInvalidOptions(result: unknown) {
    expect(result).toMatchObject({
      ok: false,
      kind: 'invalid_options',
      issue: { code: 'invalid_options' },
    });
    // 不能返回半份报告
    expect(result).not.toHaveProperty('analysis');
    expect(result).not.toHaveProperty('instructionCount');
    expect(Object.keys(result as object).sort()).toEqual(['issue', 'kind', 'ok']);
  }

  it('rejects a non-boolean constantAware flag', () => {
    expectInvalidOptions(
      validateProgram(validProgram, {
        constantAware: 'yes',
      } as unknown as ValidateOptions)
    );
    expectInvalidOptions(
      validateProgram(validProgram, {
        constantAware: 1,
      } as unknown as ValidateOptions)
    );
  });

  it('rejects unknown option keys', () => {
    expectInvalidOptions(
      validateProgram(validProgram, {
        constantAware: true,
        mode: 'fast',
      } as unknown as ValidateOptions)
    );
  });

  it('rejects non-object options', () => {
    expectInvalidOptions(validateProgram(validProgram, 'constant-aware' as never));
    expectInvalidOptions(validateProgram(validProgram, null as never));
    expectInvalidOptions(validateProgram(validProgram, [true] as never));
  });

  it('rejects invalid options before looking at the program or the JSON text', () => {
    expectInvalidOptions(
      validateProgram({ instructions: [] }, { constantAware: 'x' } as never)
    );
    expectInvalidOptions(
      validateJsonText('{"instructions":', { constantAware: 'x' } as never)
    );
    expectInvalidOptions(
      validateJsonText('[{"op":"HALT"}]', { constantAware: 0 } as never)
    );
  });
});

// ---------------------------------------------------------------------------
// 独立具体执行器：以真实值逐条执行指令，作为常量感知分析的参照。
// 分析是保守的（未知条件探索两边），因此具体执行的轨迹必须全部落在
// 分析的可达集合内，且分析证明的常量必须与具体值一致。
// ---------------------------------------------------------------------------

interface ConcreteValue {
  type: StackType;
  value: number | boolean;
}

interface ConcreteRun {
  visits: Array<{ pc: number; stack: ConcreteValue[] }>;
  maxDepth: number;
  error: { pc: number; code: string } | null;
  halted: boolean;
  truncated: boolean;
}

const CONCRETE_STEP_LIMIT = 2000;

function runConcrete(instructions: readonly RawInstruction[]): ConcreteRun {
  const decoded = instructions.map((instruction, pc) =>
    decodeInstruction(instruction, pc)
  );
  const visits: ConcreteRun['visits'] = [];
  let stack: ConcreteValue[] = [];
  let maxDepth = 0;
  let pc = 0;
  let steps = 0;

  const recordDepth = (depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
  };
  const snapshot = (): ConcreteValue[] => stack.map((value) => ({ ...value }));
  const fail = (errorPc: number, code: string): ConcreteRun => ({
    visits,
    maxDepth,
    error: { pc: errorPc, code },
    halted: false,
    truncated: false,
  });
  const fallThroughOr = (nextPc: number): ConcreteRun | null => {
    recordDepth(stack.length);
    return nextPc >= decoded.length ? fail(pc, 'fall_through') : null;
  };

  for (;;) {
    if (steps >= CONCRETE_STEP_LIMIT) {
      return { visits, maxDepth, error: null, halted: false, truncated: true };
    }
    steps += 1;
    visits.push({ pc, stack: snapshot() });
    recordDepth(stack.length);

    const item = decoded[pc]!;
    if (!item.ok) {
      return fail(pc, 'malformed_instruction');
    }
    const instruction = item.instruction;

    switch (instruction.op) {
      case 'PUSH_INT':
      case 'PUSH_BOOL': {
        if (stack.length >= MAX_STACK_DEPTH) {
          return fail(pc, 'stack_overflow');
        }
        stack.push(
          instruction.op === 'PUSH_INT'
            ? { type: 'int', value: instruction.value }
            : { type: 'bool', value: instruction.value }
        );
        const failure = fallThroughOr(pc + 1);
        if (failure) return failure;
        pc += 1;
        break;
      }
      case 'ADD': {
        if (stack.length < 2) return fail(pc, 'stack_underflow');
        const right = stack[stack.length - 1]!;
        const left = stack[stack.length - 2]!;
        if (left.type !== 'int' || right.type !== 'int') {
          return fail(pc, 'type_error');
        }
        stack = [
          ...stack.slice(0, -2),
          { type: 'int', value: (left.value as number) + (right.value as number) },
        ];
        const failure = fallThroughOr(pc + 1);
        if (failure) return failure;
        pc += 1;
        break;
      }
      case 'EQ': {
        if (stack.length < 2) return fail(pc, 'stack_underflow');
        const right = stack[stack.length - 1]!;
        const left = stack[stack.length - 2]!;
        if (left.type !== right.type) {
          return fail(pc, 'type_error');
        }
        stack = [
          ...stack.slice(0, -2),
          { type: 'bool', value: left.value === right.value },
        ];
        const failure = fallThroughOr(pc + 1);
        if (failure) return failure;
        pc += 1;
        break;
      }
      case 'NOT': {
        if (stack.length < 1) return fail(pc, 'stack_underflow');
        const top = stack[stack.length - 1]!;
        if (top.type !== 'bool') {
          return fail(pc, 'type_error');
        }
        stack = [...stack.slice(0, -1), { type: 'bool', value: !top.value }];
        const failure = fallThroughOr(pc + 1);
        if (failure) return failure;
        pc += 1;
        break;
      }
      case 'DUP': {
        if (stack.length < 1) return fail(pc, 'stack_underflow');
        if (stack.length >= MAX_STACK_DEPTH) {
          return fail(pc, 'stack_overflow');
        }
        stack = [...stack, { ...stack[stack.length - 1]! }];
        const failure = fallThroughOr(pc + 1);
        if (failure) return failure;
        pc += 1;
        break;
      }
      case 'POP': {
        if (stack.length < 1) return fail(pc, 'stack_underflow');
        stack = stack.slice(0, -1);
        const failure = fallThroughOr(pc + 1);
        if (failure) return failure;
        pc += 1;
        break;
      }
      case 'JUMP': {
        recordDepth(stack.length);
        if (instruction.target < 0 || instruction.target >= decoded.length) {
          return fail(pc, 'jump_target_out_of_bounds');
        }
        pc = instruction.target;
        break;
      }
      case 'JUMP_IF_FALSE': {
        if (stack.length < 1) return fail(pc, 'stack_underflow');
        const top = stack[stack.length - 1]!;
        if (top.type !== 'bool') {
          return fail(pc, 'type_error');
        }
        stack = stack.slice(0, -1);
        recordDepth(stack.length);
        if (top.value === false) {
          if (instruction.target < 0 || instruction.target >= decoded.length) {
            return fail(pc, 'jump_target_out_of_bounds');
          }
          pc = instruction.target;
        } else {
          if (pc + 1 >= decoded.length) {
            return fail(pc, 'fall_through');
          }
          pc += 1;
        }
        break;
      }
      case 'HALT': {
        if (stack.length !== 1) {
          return fail(pc, 'halt_stack_size');
        }
        if (stack[0]!.type !== 'bool') {
          return fail(pc, 'halt_stack_not_boolean');
        }
        return { visits, maxDepth, error: null, halted: true, truncated: false };
      }
    }
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomJumpTarget(rng: () => number, length: number): number {
  const r = rng();
  if (r < 0.7) {
    return Math.floor(rng() * length);
  }
  if (r < 0.85) {
    return Math.floor(rng() * (length + 2));
  }
  return Math.floor(rng() * 5) - 2;
}

function generateProgram(rng: () => number): RawInstruction[] {
  const length = 1 + Math.floor(rng() * 11);
  const instructions: RawInstruction[] = [];
  for (let pc = 0; pc < length; pc += 1) {
    const r = rng();
    if (r < 0.18) {
      instructions.push({ op: 'PUSH_INT', value: Math.floor(rng() * 7) - 3 });
    } else if (r < 0.33) {
      instructions.push({ op: 'PUSH_BOOL', value: rng() < 0.5 });
    } else if (r < 0.42) {
      instructions.push({ op: 'ADD' });
    } else if (r < 0.48) {
      instructions.push({ op: 'EQ' });
    } else if (r < 0.54) {
      instructions.push({ op: 'NOT' });
    } else if (r < 0.6) {
      instructions.push({ op: 'DUP' });
    } else if (r < 0.67) {
      instructions.push({ op: 'POP' });
    } else if (r < 0.78) {
      instructions.push({ op: 'JUMP', target: randomJumpTarget(rng, length) });
    } else if (r < 0.9) {
      instructions.push({
        op: 'JUMP_IF_FALSE',
        target: randomJumpTarget(rng, length),
      });
    } else if (r < 0.93) {
      instructions.push({ op: 'BOGUS' });
    } else {
      instructions.push({ op: 'HALT' });
    }
  }
  return instructions;
}

// 确定性变宽程序族：随机生成很难碰到「回边同型不同值」的形状，
// 这里系统地构造合流变未知、重新传播、裁剪出口等场景。
function wideningFamily(): RawInstruction[][] {
  const family: RawInstruction[][] = [];

  // 布尔翻转循环：循环头的 bool 在两次迭代间翻转，合流后未知
  for (const initial of [true, false]) {
    family.push([bool(initial), not(), dup(), jif(1), pop(), bool(true), halt()]);
    // 循环出口是坏指令：首次到达裁掉落点后，变宽必须重新传播才能发现
    family.push([bool(initial), not(), dup(), jif(1), bad()]);
    // 变宽后再嵌套一层可证明为常量的分支
    family.push([
      bool(initial),
      not(),
      dup(),
      jif(1),
      pop(),
      bool(true),
      jif(9),
      bool(true),
      halt(),
      bad(),
    ]);
  }

  // 整数计数循环：回边把不同的 int 常量带回循环头
  for (const start of [0, 1, -2]) {
    for (const step of [1, 2]) {
      family.push([
        int(start),
        int(step),
        add(),
        bool(true),
        jif(6),
        jump(1),
        pop(),
        bool(true),
        halt(),
      ]);
    }
  }

  // 条件可证明为假：循环体整体不可达，默认模式却会在其中报错
  family.push([bool(false), jif(4), not(), jump(1), bool(true), halt()]);

  // 变宽后的未知条件两边都探索
  family.push([
    bool(true),
    not(),
    dup(),
    jif(1),
    dup(),
    jif(9),
    not(),
    pop(),
    jump(10),
    pop(),
    bool(true),
    halt(),
  ]);
  // 同上，但假分支里有下溢错误，保守探索必须报告
  family.push([
    bool(true),
    not(),
    dup(),
    jif(1),
    dup(),
    jif(9),
    not(),
    pop(),
    jump(10),
    add(),
    bool(true),
    halt(),
  ]);
  // 未知值参与 EQ 后仍然未知，两个分支都可达
  family.push([
    bool(true),
    not(),
    dup(),
    jif(1),
    bool(true),
    { op: 'EQ' },
    jif(9),
    bool(true),
    halt(),
    bool(false),
    halt(),
  ]);

  return family;
}

describe('constant-aware analysis vs independent concrete executor', () => {
  const coverage = {
    conflict: 0,
    concreteError: 0,
    truncated: 0,
    halted: 0,
    constOnlyDead: 0,
    unknownSlot: 0,
  };

  function checkConsistency(instructions: RawInstruction[], failures: string[]): void {
    const label = JSON.stringify(instructions);
    const fail = (problem: string): void => {
      failures.push(`${label}: ${problem}`);
    };

    const constRes = validateProgram(program(instructions), {
      constantAware: true,
    });
    if (constRes.kind !== 'program' || !('mode' in constRes)) {
      throw new Error(`unexpected result kind for ${label}`);
    }
    const analysis = constRes.analysis;
    const run = runConcrete(instructions);
    const hasConflict = analysis.issues.some(
      (issue) => issue.code === 'stack_merge_conflict'
    );

    if (hasConflict) {
      coverage.conflict += 1;
      // 合流冲突时分析记录的栈状态不再代表所有入边，具体轨迹可能分叉，
      // 此时只要求分析判定为无效。
      if (analysis.valid) {
        fail('merge conflict must make the program invalid');
      }
    } else {
      const reachable = new Set(analysis.reachablePcs);
      for (const visit of run.visits) {
        // 具体执行经过的 PC 必须可达，绝不能列入 deadPcs
        if (!reachable.has(visit.pc)) {
          fail(`concrete run visits PC ${visit.pc} missing from reachablePcs`);
        }
        if (analysis.deadPcs.includes(visit.pc)) {
          fail(`concrete run visits PC ${visit.pc} listed in deadPcs`);
        }
        const signature = analysis.pcSignatures[visit.pc];
        if (signature === undefined || signature.length !== visit.stack.length) {
          fail(`signature at PC ${visit.pc} does not match concrete stack`);
          continue;
        }
        visit.stack.forEach((value, index) => {
          const slot = signature[index]!;
          if (slot.type !== value.type) {
            fail(`slot ${index} type at PC ${visit.pc}: ${slot.type} != ${value.type}`);
          }
          // 分析证明的常量必须与具体值一致
          if (slot.value !== null && slot.value !== value.value) {
            fail(
              `proven constant at PC ${visit.pc} slot ${index}: ${String(slot.value)} != ${String(value.value)}`
            );
          }
        });
      }
      if (run.maxDepth > analysis.maxStackDepth) {
        fail(`concrete depth ${run.maxDepth} exceeds maxStackDepth ${analysis.maxStackDepth}`);
      }
      if (run.error) {
        // 具体执行撞到的错误必须出现在报告中
        const reported = analysis.issues.some(
          (issue) => issue.pc === run.error!.pc && issue.code === run.error!.code
        );
        if (!reported) {
          fail(`concrete error ${run.error.code} at PC ${run.error.pc} not reported`);
        }
        coverage.concreteError += 1;
      }
    }

    if (run.truncated) coverage.truncated += 1;
    if (run.halted) coverage.halted += 1;

    const defaultRes = validateProgram(program(instructions));
    if (defaultRes.kind !== 'program') {
      throw new Error(`unexpected default result kind for ${label}`);
    }
    const fallback = defaultRes.analysis;

    // 常量模式探索的边是默认模式的子集
    for (const reachablePc of analysis.reachablePcs) {
      if (!fallback.reachablePcs.includes(reachablePc)) {
        fail(`PC ${reachablePc} reachable in constant mode but not in default mode`);
      }
    }
    for (const deadPc of fallback.deadPcs) {
      if (!analysis.deadPcs.includes(deadPc)) {
        fail(`PC ${deadPc} dead in default mode but reachable in constant mode`);
      }
    }
    if (analysis.maxStackDepth > fallback.maxStackDepth) {
      fail('constant mode maxStackDepth exceeds default mode');
    }
    // 默认模式有效时，常量模式绝不允许报错
    if (fallback.valid && analysis.issues.length > 0) {
      fail('constant mode reports issues for a program valid in default mode');
    }

    if (analysis.deadPcs.some((pc) => !fallback.deadPcs.includes(pc))) {
      coverage.constOnlyDead += 1;
    }
    if (
      Object.values(analysis.pcSignatures).some((signature) =>
        signature.some((slot) => slot.value === null)
      )
    ) {
      coverage.unknownSlot += 1;
    }
  }

  it('stays consistent with concrete runs on generated small programs', () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 1500; seed += 1) {
      const rng = mulberry32(seed);
      checkConsistency(generateProgram(rng), failures);
    }
    for (const instructions of wideningFamily()) {
      checkConsistency(instructions, failures);
    }

    expect(failures.slice(0, 20)).toEqual([]);

    // 生成器与程序族必须真的覆盖到关键场景，否则对拍形同虚设
    expect(coverage.conflict).toBeGreaterThan(0);
    expect(coverage.concreteError).toBeGreaterThan(0);
    expect(coverage.truncated).toBeGreaterThan(0);
    expect(coverage.halted).toBeGreaterThan(0);
    expect(coverage.constOnlyDead).toBeGreaterThan(0);
    expect(coverage.unknownSlot).toBeGreaterThan(0);
  });
});

export const MIN_PROGRAM_LENGTH = 1;
export const MAX_PROGRAM_LENGTH = 500;
export const MAX_STACK_DEPTH = 32;

export type StackType = 'int' | 'bool';

export type OpCode =
  | 'PUSH_INT'
  | 'PUSH_BOOL'
  | 'ADD'
  | 'EQ'
  | 'NOT'
  | 'DUP'
  | 'POP'
  | 'JUMP'
  | 'JUMP_IF_FALSE'
  | 'HALT';

export interface PushIntInstruction {
  op: 'PUSH_INT';
  value: number;
}

export interface PushBoolInstruction {
  op: 'PUSH_BOOL';
  value: boolean;
}

export interface NoOperandInstruction {
  op: 'ADD' | 'EQ' | 'NOT' | 'DUP' | 'POP' | 'HALT';
}

export interface JumpInstruction {
  op: 'JUMP';
  target: number;
}

export interface JumpIfFalseInstruction {
  op: 'JUMP_IF_FALSE';
  target: number;
}

export type Instruction =
  | PushIntInstruction
  | PushBoolInstruction
  | NoOperandInstruction
  | JumpInstruction
  | JumpIfFalseInstruction;

export type DecodedInstruction =
  | { ok: true; pc: number; instruction: Instruction }
  | {
      ok: false;
      pc: number;
      op: string | number | null;
      reason:
        | 'instruction_not_object'
        | 'missing_op'
        | 'unsupported_op'
        | 'missing_integer_value'
        | 'missing_boolean_value'
        | 'missing_integer_target';
    };

/**
 * 常量感知模式下的栈槽：在类型之外记录可证明的常量值。
 * value 为 null 表示该槽的值在分析中不可证明（未知）。
 */
export interface ConstantSlot {
  type: StackType;
  value: number | boolean | null;
}

export interface AttemptedOperation<S = StackType> {
  type: 'operation';
  pc: number;
  op: string;
  stackAfter?: S[];
}

export interface AttemptedJump {
  type: 'jump';
  fromPc: number;
  op: 'JUMP' | 'JUMP_IF_FALSE';
  targetPc: number;
  programLength: number;
}

export interface AttemptedFallThrough {
  type: 'fall_through';
  fromPc: number;
  targetPc: number;
  programLength: number;
}

export type AttemptedEdge<S = StackType> =
  | AttemptedOperation<S>
  | AttemptedJump
  | AttemptedFallThrough;

export interface WitnessEdge<S = StackType> {
  type: 'fall' | 'jump' | 'true_branch' | 'false_branch';
  fromPc: number;
  toPc: number;
  op: string;
  stackAfter: S[];
}

export interface MergeConflictWitness<S = StackType> {
  existingStack: S[];
  incomingStack: S[];
  existingPath: WitnessEdge<S>[];
  incomingPath: WitnessEdge<S>[];
}

export interface Witness<S = StackType> {
  startPc: 0;
  entryStack: S[];
  path: WitnessEdge<S>[];
  attempted?: AttemptedEdge<S>;
  conflicts?: MergeConflictWitness<S>;
}

export interface ValidationIssue<S = StackType> {
  pc: number;
  code: string;
  message: string;
  entryStack: S[];
  witness: Witness<S>;
  details?: Record<string, unknown>;
}

export interface StructuralIssue {
  code:
    | 'input_not_object'
    | 'instructions_not_array'
    | 'instruction_count_out_of_range';
  message: string;
  details?: Record<string, unknown>;
}

export interface OptionsIssue {
  code: 'invalid_options';
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidateOptions {
  /**
   * 启用常量感知分析：栈状态在类型之外跟踪可证明的常量，
   * 可证明不会走到的分支不再探索。缺省（false）为纯类型分析，
   * 输出与历史版本逐字段一致。
   */
  constantAware?: boolean;
}

export interface ProgramAnalysis<S = StackType> {
  valid: boolean;
  status: 'valid' | 'invalid';
  reachablePcs: number[];
  deadPcs: number[];
  pcSignatures: Record<number, S[]>;
  maxStackDepth: number;
  issues: ValidationIssue<S>[];
}

export interface JsonParseErrorResult {
  ok: false;
  kind: 'json_parse_error';
  issue: { code: 'invalid_json'; message: string };
}

export interface StructuralErrorResult {
  ok: false;
  kind: 'structural_error';
  issue: StructuralIssue;
}

export interface InvalidOptionsResult {
  ok: false;
  kind: 'invalid_options';
  issue: OptionsIssue;
}

export type ValidationFailure =
  | JsonParseErrorResult
  | StructuralErrorResult
  | InvalidOptionsResult;

export interface ProgramResult {
  ok: boolean;
  kind: 'program';
  instructionCount: number;
  analysis: ProgramAnalysis<StackType>;
}

export interface ConstantProgramResult {
  ok: boolean;
  kind: 'program';
  mode: 'constant_aware';
  instructionCount: number;
  analysis: ProgramAnalysis<ConstantSlot>;
}

export type ValidationResult = ValidationFailure | ProgramResult;

export type ConstantValidationResult = ValidationFailure | ConstantProgramResult;

const NO_OPERAND_OPS: ReadonlySet<string> = new Set([
  'ADD',
  'EQ',
  'NOT',
  'DUP',
  'POP',
  'HALT',
]);

function isIntegerLike(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function decodeInstruction(
  rawInstruction: unknown,
  pc: number
): DecodedInstruction {
  if (typeof rawInstruction !== 'object' || rawInstruction === null) {
    return { ok: false, pc, op: null, reason: 'instruction_not_object' };
  }

  const record = rawInstruction as Record<string, unknown>;
  if (!('op' in record)) {
    return { ok: false, pc, op: null, reason: 'missing_op' };
  }

  const op = record.op;
  const opName = typeof op === 'string' || typeof op === 'number' ? op : null;

  if (typeof op !== 'string') {
    return { ok: false, pc, op: opName, reason: 'unsupported_op' };
  }

  if (NO_OPERAND_OPS.has(op)) {
    return {
      ok: true,
      pc,
      instruction: { op: op as NoOperandInstruction['op'] },
    };
  }

  if (op === 'PUSH_INT') {
    if (!isIntegerLike(record.value)) {
      return { ok: false, pc, op, reason: 'missing_integer_value' };
    }
    return { ok: true, pc, instruction: { op, value: record.value } };
  }

  if (op === 'PUSH_BOOL') {
    if (typeof record.value !== 'boolean') {
      return { ok: false, pc, op, reason: 'missing_boolean_value' };
    }
    return { ok: true, pc, instruction: { op, value: record.value } };
  }

  if (op === 'JUMP' || op === 'JUMP_IF_FALSE') {
    if (!isIntegerLike(record.target)) {
      return { ok: false, pc, op, reason: 'missing_integer_target' };
    }
    return { ok: true, pc, instruction: { op, target: record.target } };
  }

  return { ok: false, pc, op, reason: 'unsupported_op' };
}

function decodeProgram(instructions: readonly unknown[]): DecodedInstruction[] {
  return instructions.map((instruction, pc) =>
    decodeInstruction(instruction, pc)
  );
}

function sameStack(left: readonly StackType[], right: readonly StackType[]): boolean {
  return left.length === right.length && left.every((type, index) => type === right[index]);
}

function malformedMessage(reason: string): string {
  const messages: Record<string, string> = {
    instruction_not_object: '指令必须是包含 op 字段的对象',
    missing_op: '指令缺少 op 字段',
    unsupported_op: '不支持的操作码',
    missing_integer_value: 'PUSH_INT 需要整数字段 value',
    missing_boolean_value: 'PUSH_BOOL 需要布尔字段 value',
    missing_integer_target: '跳转指令需要整数字段 target',
  };
  return messages[reason] ?? '指令格式错误';
}

/**
 * 抽象域语义。默认模式只跟踪栈类型（S = StackType）；常量感知模式
 * 额外跟踪可证明的常量（S = ConstantSlot）。两种模式共享同一套
 * 工作队列引擎，错误检查只依赖类型与栈深，因此在两个域中一致。
 */
interface Semantics<S> {
  cloneStack(stack: readonly S[]): S[];
  slotType(slot: S): StackType;
  pushInt(value: number): S;
  pushBool(value: boolean): S;
  add(left: S, right: S): S;
  equal(left: S, right: S): S;
  not(value: S): S;
  /**
   * 同一 PC 的入边合流。栈类型序列不兼容时返回 null（合流冲突）；
   * 否则返回合流后的栈，changed 表示相对 existing 是否变宽。
   * 变宽时必须用合流状态重新传播，不能沿用首次到达时裁掉的后继。
   */
  joinStacks(
    existing: readonly S[],
    incoming: readonly S[]
  ): { stack: S[]; changed: boolean } | null;
  /** JUMP_IF_FALSE 弹出 top 后需要探索的分支；可证明的常量条件会裁掉不会走的一侧。 */
  branches(top: S): { trueBranch: boolean; falseBranch: boolean };
}

const typeSemantics: Semantics<StackType> = {
  cloneStack: (stack) => [...stack],
  slotType: (slot) => slot,
  pushInt: () => 'int',
  pushBool: () => 'bool',
  add: () => 'int',
  equal: () => 'bool',
  not: () => 'bool',
  joinStacks: (existing, incoming) =>
    sameStack(existing, incoming)
      ? { stack: [...existing], changed: false }
      : null,
  branches: () => ({ trueBranch: true, falseBranch: true }),
};

const unknownSlot = (type: StackType): ConstantSlot => ({ type, value: null });

const constantSemantics: Semantics<ConstantSlot> = {
  cloneStack: (stack) => stack.map((slot) => ({ ...slot })),
  slotType: (slot) => slot.type,
  pushInt: (value) => ({ type: 'int', value }),
  pushBool: (value) => ({ type: 'bool', value }),
  add: (left, right) =>
    typeof left.value === 'number' && typeof right.value === 'number'
      ? { type: 'int', value: left.value + right.value }
      : unknownSlot('int'),
  equal: (left, right) =>
    left.value !== null && right.value !== null
      ? { type: 'bool', value: left.value === right.value }
      : unknownSlot('bool'),
  not: (value) =>
    typeof value.value === 'boolean'
      ? { type: 'bool', value: !value.value }
      : unknownSlot('bool'),
  joinStacks: (existing, incoming) => {
    if (existing.length !== incoming.length) {
      return null;
    }
    let changed = false;
    const merged: ConstantSlot[] = [];
    for (let index = 0; index < existing.length; index += 1) {
      const left = existing[index]!;
      const right = incoming[index]!;
      if (left.type !== right.type) {
        return null;
      }
      if (left.value === null || right.value === null) {
        merged.push(unknownSlot(left.type));
        if (left.value !== null) {
          changed = true;
        }
      } else if (left.value === right.value) {
        merged.push({ type: left.type, value: left.value });
      } else {
        // 同型不同常量：合流后该槽不可证明，变宽为未知
        merged.push(unknownSlot(left.type));
        changed = true;
      }
    }
    return { stack: merged, changed };
  },
  branches: (top) => {
    if (top.value === true) {
      return { trueBranch: true, falseBranch: false };
    }
    if (top.value === false) {
      return { trueBranch: false, falseBranch: true };
    }
    return { trueBranch: true, falseBranch: true };
  },
};

interface WorkItem<S> {
  pc: number;
  stack: S[];
  path: WitnessEdge<S>[];
}

function edge<S>(
  type: WitnessEdge<S>['type'],
  fromPc: number,
  toPc: number,
  op: string,
  stackAfter: readonly S[]
): WitnessEdge<S> {
  return {
    type,
    fromPc,
    toPc,
    op,
    stackAfter: [...stackAfter],
  };
}

function cloneWitnessPath<S>(path: readonly WitnessEdge<S>[]): WitnessEdge<S>[] {
  return path.map((item) => ({ ...item, stackAfter: [...item.stackAfter] }));
}

function makeIssue<S>(
  pc: number,
  code: string,
  message: string,
  entryStack: readonly S[],
  path: readonly WitnessEdge<S>[],
  options: {
    attempted?: AttemptedEdge<S>;
    conflicts?: MergeConflictWitness<S>;
    details?: Record<string, unknown>;
  } = {}
): ValidationIssue<S> {
  const witness: Witness<S> = {
    startPc: 0,
    entryStack: [...entryStack],
    path: cloneWitnessPath(path),
  };

  if (options.attempted) {
    witness.attempted = options.attempted;
  }
  if (options.conflicts) {
    witness.conflicts = options.conflicts;
  }

  return {
    pc,
    code,
    message,
    entryStack: [...entryStack],
    witness,
    ...(options.details ? { details: options.details } : {}),
  };
}

function structuralIssue(
  code: StructuralIssue['code'],
  message: string,
  details?: Record<string, unknown>
): ValidationResult {
  return {
    ok: false,
    kind: 'structural_error',
    issue: { code, message, ...(details ? { details } : {}) },
  };
}

function analyzeProgram<S>(
  decoded: DecodedInstruction[],
  semantics: Semantics<S>
): ProgramAnalysis<S> {
  const programLength = decoded.length;
  const arrivals = new Map<number, S[]>();
  const arrivalPaths = new Map<number, WitnessEdge<S>[]>();
  const issueByPc = new Map<number, ValidationIssue<S>>();
  const queue: WorkItem<S>[] = [{ pc: 0, stack: [], path: [] }];
  let maxStackDepth = 0;

  const recordDepth = (depth: number): void => {
    maxStackDepth = Math.max(maxStackDepth, depth);
  };

  const addIssue = (issue: ValidationIssue<S>): void => {
    // A later back/branch edge can reach a PC after BFS already evaluated one
    // predecessor. The merge mismatch is the controlling error at that PC and
    // must not be hidden by an issue observed through only one predecessor.
    if (issue.code === 'stack_merge_conflict' || !issueByPc.has(issue.pc)) {
      issueByPc.set(issue.pc, issue);
    }
  };

  // 返回 null 表示不再处理；否则返回应当（重新）传播的状态。
  // 同型不同值合流后状态变宽时，用合流状态从该 PC 重新传播，
  // 首次到达时裁掉的后继不能沿用。
  const arrive = (item: WorkItem<S>): WorkItem<S> | null => {
    const existing = arrivals.get(item.pc);
    if (existing === undefined) {
      arrivals.set(item.pc, semantics.cloneStack(item.stack));
      arrivalPaths.set(item.pc, cloneWitnessPath(item.path));
      return item;
    }

    const joined = semantics.joinStacks(existing, item.stack);
    if (joined === null) {
      const existingPath = arrivalPaths.get(item.pc) ?? [];
      const conflicts: MergeConflictWitness<S> = {
        existingStack: semantics.cloneStack(existing),
        incomingStack: semantics.cloneStack(item.stack),
        existingPath: cloneWitnessPath(existingPath),
        incomingPath: cloneWitnessPath(item.path),
      };
      addIssue(
        makeIssue(
          item.pc,
          'stack_merge_conflict',
          `PC ${item.pc} 的不同可达入边具有不同栈类型序列，控制流不能合流`,
          item.stack,
          item.path,
          {
            conflicts,
            details: {
              existingStack: conflicts.existingStack,
              incomingStack: conflicts.incomingStack,
            },
          }
        )
      );
      return null;
    }

    if (!joined.changed) {
      return null;
    }

    arrivals.set(item.pc, semantics.cloneStack(joined.stack));
    // 见证路径保留首次到达的路径：它是到达该 PC 的一条真实控制流路径。
    const recordedPath = arrivalPaths.get(item.pc) ?? [];
    return {
      pc: item.pc,
      stack: joined.stack,
      path: cloneWitnessPath(recordedPath),
    };
  };

  const enqueueSuccessor = (
    fromPc: number,
    toPc: number,
    stackAfter: S[],
    pathAfter: WitnessEdge<S>[],
    edgeType: WitnessEdge<S>['type'],
    op: string
  ): void => {
    const nextPath = [
      ...pathAfter,
      edge(edgeType, fromPc, toPc, op, stackAfter),
    ];
    queue.push({ pc: toPc, stack: stackAfter, path: nextPath });
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    const arrived = arrive(current);
    if (arrived === null) {
      continue;
    }

    const { pc, stack, path } = arrived;
    recordDepth(stack.length);

    const decodedInstruction = decoded[pc];
    if (decodedInstruction === undefined) {
      continue;
    }

    if (!decodedInstruction.ok) {
      addIssue(
        makeIssue(
          pc,
          'malformed_instruction',
          malformedMessage(decodedInstruction.reason),
          stack,
          path,
          {
            attempted: { type: 'operation', pc, op: String(decodedInstruction.op) },
            details: {
              reason: decodedInstruction.reason,
              op: decodedInstruction.op,
            },
          }
        )
      );
      continue;
    }

    const instruction = decodedInstruction.instruction;
    const op = instruction.op;

    const operationIssue = (
      code: string,
      message: string,
      details?: Record<string, unknown>,
      stackAfter?: S[]
    ): void => {
      addIssue(
        makeIssue(pc, code, message, stack, path, {
          attempted: { type: 'operation', pc, op, ...(stackAfter ? { stackAfter } : {}) },
          ...(details ? { details } : {}),
        })
      );
    };

    const underflow = (expected: number): void => {
      operationIssue(
        'stack_underflow',
        `PC ${pc} 的 ${op} 需要至少 ${expected} 个栈值，但当前只有 ${stack.length} 个`,
        { expected, actual: stack.length }
      );
    };

    const continueAt = (
      nextPc: number,
      stackAfter: S[],
      edgeType: WitnessEdge<S>['type'] = 'fall'
    ): void => {
      recordDepth(stackAfter.length);
      if (nextPc >= programLength) {
        addIssue(
          makeIssue(
            pc,
            'fall_through',
            `PC ${pc} 执行后跌出程序末尾`,
            stack,
            path,
            {
              attempted: {
                type: 'fall_through',
                fromPc: pc,
                targetPc: nextPc,
                programLength,
              },
              details: { targetPc: nextPc, programLength },
            }
          )
        );
        return;
      }
      enqueueSuccessor(pc, nextPc, stackAfter, path, edgeType, op);
    };

    const jumpTo = (
      targetPc: number,
      stackAfter: S[],
      edgeType: 'jump' | 'true_branch' | 'false_branch'
    ): void => {
      recordDepth(stackAfter.length);
      if (targetPc < 0 || targetPc >= programLength) {
        addIssue(
          makeIssue(
            pc,
            'jump_target_out_of_bounds',
            `PC ${pc} 的 ${op} 目标地址 ${targetPc} 越界`,
            stack,
            path,
            {
              attempted: {
                type: 'jump',
                fromPc: pc,
                op: op === 'JUMP' ? 'JUMP' : 'JUMP_IF_FALSE',
                targetPc,
                programLength,
              },
              details: { targetPc, programLength },
            }
          )
        );
        return;
      }
      enqueueSuccessor(pc, targetPc, stackAfter, path, edgeType, op);
    };

    switch (instruction.op) {
      case 'PUSH_INT': {
        if (stack.length >= MAX_STACK_DEPTH) {
          operationIssue(
            'stack_overflow',
            `PC ${pc} 入栈将超过最大栈深 ${MAX_STACK_DEPTH}`,
            {
              maxStackDepth: MAX_STACK_DEPTH,
              attemptedSize: stack.length + 1,
            },
            [...stack, semantics.pushInt(instruction.value)]
          );
          break;
        }
        continueAt(pc + 1, [...stack, semantics.pushInt(instruction.value)]);
        break;
      }

      case 'PUSH_BOOL': {
        if (stack.length >= MAX_STACK_DEPTH) {
          operationIssue(
            'stack_overflow',
            `PC ${pc} 入栈将超过最大栈深 ${MAX_STACK_DEPTH}`,
            {
              maxStackDepth: MAX_STACK_DEPTH,
              attemptedSize: stack.length + 1,
            },
            [...stack, semantics.pushBool(instruction.value)]
          );
          break;
        }
        continueAt(pc + 1, [...stack, semantics.pushBool(instruction.value)]);
        break;
      }

      case 'ADD': {
        if (stack.length < 2) {
          underflow(2);
          break;
        }
        const right = stack[stack.length - 1]!;
        const left = stack[stack.length - 2]!;
        const leftType = semantics.slotType(left);
        const rightType = semantics.slotType(right);
        if (leftType !== 'int' || rightType !== 'int') {
          operationIssue(
            'type_error',
            `PC ${pc} 的 ADD 只接受两个整数`,
            {
              expected: ['int', 'int'],
              actual: [leftType, rightType],
              leftType,
              rightType,
            }
          );
          break;
        }
        const nextStack = [...stack.slice(0, -2), semantics.add(left, right)];
        continueAt(pc + 1, nextStack);
        break;
      }

      case 'EQ': {
        if (stack.length < 2) {
          underflow(2);
          break;
        }
        const right = stack[stack.length - 1]!;
        const left = stack[stack.length - 2]!;
        const leftType = semantics.slotType(left);
        const rightType = semantics.slotType(right);
        if (leftType !== rightType) {
          operationIssue(
            'type_error',
            `PC ${pc} 的 EQ 只能比较两个同类型值`,
            {
              leftType,
              rightType,
            }
          );
          break;
        }
        continueAt(pc + 1, [...stack.slice(0, -2), semantics.equal(left, right)]);
        break;
      }

      case 'NOT': {
        if (stack.length < 1) {
          underflow(1);
          break;
        }
        const top = stack[stack.length - 1]!;
        const topType = semantics.slotType(top);
        if (topType !== 'bool') {
          operationIssue(
            'type_error',
            `PC ${pc} 的 NOT 只接受布尔值`,
            { expected: 'bool', actual: topType, topType }
          );
          break;
        }
        continueAt(pc + 1, [...stack.slice(0, -1), semantics.not(top)]);
        break;
      }

      case 'DUP': {
        if (stack.length < 1) {
          underflow(1);
          break;
        }
        const top = stack[stack.length - 1]!;
        if (stack.length >= MAX_STACK_DEPTH) {
          operationIssue(
            'stack_overflow',
            `PC ${pc} 复制栈顶将超过最大栈深 ${MAX_STACK_DEPTH}`,
            {
              maxStackDepth: MAX_STACK_DEPTH,
              attemptedSize: stack.length + 1,
            },
            [...stack, top]
          );
          break;
        }
        continueAt(pc + 1, [...stack, top]);
        break;
      }

      case 'POP': {
        if (stack.length < 1) {
          underflow(1);
          break;
        }
        continueAt(pc + 1, stack.slice(0, -1));
        break;
      }

      case 'JUMP': {
        jumpTo(instruction.target, semantics.cloneStack(stack), 'jump');
        break;
      }

      case 'JUMP_IF_FALSE': {
        if (stack.length < 1) {
          underflow(1);
          break;
        }
        const top = stack[stack.length - 1]!;
        const topType = semantics.slotType(top);
        if (topType !== 'bool') {
          operationIssue(
            'type_error',
            `PC ${pc} 的 JUMP_IF_FALSE 只接受弹出的布尔值`,
            { expected: 'bool', actual: topType, topType }
          );
          break;
        }
        const afterPop = stack.slice(0, -1);
        const { trueBranch, falseBranch } = semantics.branches(top);
        if (falseBranch) {
          jumpTo(instruction.target, semantics.cloneStack(afterPop), 'false_branch');
        }
        if (trueBranch) {
          continueAt(pc + 1, semantics.cloneStack(afterPop), 'true_branch');
        }
        break;
      }

      case 'HALT': {
        if (stack.length !== 1) {
          operationIssue(
            'halt_stack_size',
            `HALT 时栈必须恰有一个值，当前有 ${stack.length} 个`,
            { expectedSize: 1, actualSize: stack.length }
          );
          break;
        }
        const topType = semantics.slotType(stack[0]!);
        if (topType !== 'bool') {
          operationIssue(
            'halt_stack_not_boolean',
            'HALT 时唯一的栈值必须是布尔值',
            { expected: 'bool', actual: topType, topType }
          );
        }
        break;
      }
    }
  }

  const reachablePcs = [...arrivals.keys()].sort((a, b) => a - b);
  const pcSignatures = Object.fromEntries(
    reachablePcs.map((pc) => [pc, semantics.cloneStack(arrivals.get(pc) ?? [])])
  );
  const deadPcs = decoded
    .map((_, pc) => pc)
    .filter((pc) => !arrivals.has(pc));

  const issues = [...issueByPc.values()].sort((left, right) => {
    if (left.pc !== right.pc) {
      return left.pc - right.pc;
    }
    return left.code.localeCompare(right.code);
  });

  return {
    valid: issues.length === 0,
    status: issues.length === 0 ? 'valid' : 'invalid',
    reachablePcs,
    deadPcs,
    pcSignatures,
    maxStackDepth,
    issues,
  };
}

const KNOWN_OPTION_KEYS: ReadonlySet<string> = new Set(['constantAware']);

type NormalizedOptions =
  | { ok: true; constantAware: boolean }
  | { ok: false; issue: OptionsIssue };

// 模式选项本身非法时整次拒绝，不返回任何部分分析结果。
function normalizeOptions(options: unknown): NormalizedOptions {
  const reject = (
    message: string,
    details?: Record<string, unknown>
  ): NormalizedOptions => ({
    ok: false,
    issue: {
      code: 'invalid_options',
      message,
      ...(details ? { details } : {}),
    },
  });

  if (options === undefined) {
    return { ok: true, constantAware: false };
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return reject('分析选项必须是对象，例如 { "constantAware": true }');
  }
  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_OPTION_KEYS.has(key)) {
      return reject(`未知的分析选项 ${key}`, { option: key });
    }
  }
  const constantAware = record.constantAware;
  if (constantAware !== undefined && typeof constantAware !== 'boolean') {
    return reject('constantAware 选项必须是布尔值', {
      option: 'constantAware',
    });
  }
  return { ok: true, constantAware: constantAware === true };
}

export function validateProgram(
  input: unknown,
  options: { constantAware: true }
): ConstantValidationResult;
export function validateProgram(
  input: unknown,
  options?: ValidateOptions
): ValidationResult;
export function validateProgram(
  input: unknown,
  options?: ValidateOptions
): ValidationResult | ConstantValidationResult {
  const normalized = normalizeOptions(options);
  if (!normalized.ok) {
    return { ok: false, kind: 'invalid_options', issue: normalized.issue };
  }

  if (typeof input !== 'object' || input === null) {
    return structuralIssue('input_not_object', '输入必须是指令数组或包含 instructions 数组的对象');
  }

  const rawInstructions = Array.isArray(input)
    ? input
    : (input as Record<string, unknown>).instructions;
  if (!Array.isArray(rawInstructions)) {
    return structuralIssue(
      'instructions_not_array',
      '输入必须是指令数组，或包含数组字段 instructions 的对象'
    );
  }
  if (
    rawInstructions.length < MIN_PROGRAM_LENGTH ||
    rawInstructions.length > MAX_PROGRAM_LENGTH
  ) {
    return structuralIssue(
      'instruction_count_out_of_range',
      `指令数量必须在 ${MIN_PROGRAM_LENGTH} 到 ${MAX_PROGRAM_LENGTH} 条之间`,
      {
        min: MIN_PROGRAM_LENGTH,
        max: MAX_PROGRAM_LENGTH,
        actual: rawInstructions.length,
      }
    );
  }

  const decoded = decodeProgram(rawInstructions);

  if (normalized.constantAware) {
    const analysis = analyzeProgram(decoded, constantSemantics);
    return {
      ok: analysis.valid,
      kind: 'program',
      mode: 'constant_aware',
      instructionCount: decoded.length,
      analysis,
    };
  }

  const analysis = analyzeProgram(decoded, typeSemantics);
  return {
    ok: analysis.valid,
    kind: 'program',
    instructionCount: decoded.length,
    analysis,
  };
}

export function validateJsonText(
  text: string,
  options: { constantAware: true }
): ConstantValidationResult;
export function validateJsonText(
  text: string,
  options?: ValidateOptions
): ValidationResult;
export function validateJsonText(
  text: string,
  options?: ValidateOptions
): ValidationResult | ConstantValidationResult {
  const normalized = normalizeOptions(options);
  if (!normalized.ok) {
    return { ok: false, kind: 'invalid_options', issue: normalized.issue };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return normalized.constantAware
      ? validateProgram(parsed, { constantAware: true })
      : validateProgram(parsed);
  } catch (error) {
    return {
      ok: false,
      kind: 'json_parse_error',
      issue: {
        code: 'invalid_json',
        message: error instanceof Error ? error.message : 'JSON 解析失败',
      },
    };
  }
}

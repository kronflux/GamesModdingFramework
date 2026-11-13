// Turns the flat statement list of one decoded Blueprint function into structured lines:
// if/else, while loops and Sequence blocks, or reports why it must stay flat.
//
// Input is the `statements` array `disassemble` (kismet.mjs) returns. Method:
//   1. Split the statements into basic blocks at jump targets and after control statements.
//   2. Resolve the execution-flow stack (EX_PushExecutionFlow / EX_PopExecutionFlow) by
//      walking the blocks with the stack each block is entered with, so every pop becomes an
//      ordinary edge to the block it returns to. A block entered with two different stacks is
//      not handled.
//   3. Compute dominators and post-dominators of the block graph. A retreating edge to a block
//      that does not dominate its source makes the graph irreducible. A back edge to a
//      dominator makes a loop; a conditional rejoins at its immediate post-dominator.
//   4. Walk the graph from the entry, emitting each block once: a loop header opens a `while`,
//      a conditional opens `if`/`else` up to its join, a push opens consecutive sequence blocks.
//      A jump to the function's closing `return` from inside a branch prints as `return`.
//      A walk that would otherwise leave its region (needing a goto, or a break other than
//      the loop exit) makes the function flat.
//
// The emitted non-control statements are counted against the input; any difference makes the
// function flat with "statement count mismatch", so a structured result never drops, repeats
// or reorders a statement.

const CONTROL_OPS = new Set([
  "EX_Jump", "EX_JumpIfNot", "EX_PushExecutionFlow", "EX_PopExecutionFlow", "EX_PopExecutionFlowIfNot",
]);
const TARGET_OPS = new Set(["EX_Jump", "EX_JumpIfNot", "EX_PushExecutionFlow"]);
const MAX_FLOW_STACK = 64;

/** Thrown inside this module to end structuring with a reason; never escapes `structure`. */
class Flat extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Structures one function's statements.
 *
 * Returns `{ kind: "structured", lines, statements }`, where `lines` are display lines indented
 * by two spaces per level and `statements` is the number of non-control statements, each
 * emitted exactly once; or `{ kind: "flat", reason }`.
 */
export function structure(statements) {
  try {
    return structureOrThrow(statements);
  } catch (error) {
    if (error instanceof Flat) return { kind: "flat", reason: error.reason };
    throw error;
  }
}

function structureOrThrow(statements) {
  if (statements.some((s) => s.op === "EX_ComputedJump")) throw new Flat("computed jump (event graph)");
  const graph = buildGraph(statements);
  analyse(graph);
  const emitter = new Emitter(statements, graph);
  emitter.region(graph.entry, graph.exit, 0);
  if (graph.finalReturn !== null) emitter.statement(graph.finalReturn, 0);

  const expected = statements.filter((s) => !CONTROL_OPS.has(s.op)).length;
  if (emitter.count !== expected || emitter.emitted.size !== expected) throw new Flat("statement count mismatch");
  return { kind: "structured", lines: emitter.lines, statements: expected };
}

// --- 1 and 2: blocks and edges

/** The condition text of a JumpIfNot (`if not (<c>) goto 0xNNNN`) or PopIfNot (`if not (<c>) pop`). */
function conditionOf(statement) {
  const pattern = statement.op === "EX_JumpIfNot" ? /^if not \((.*)\) goto 0x[0-9A-F]+$/s : /^if not \((.*)\) pop$/s;
  const match = pattern.exec(statement.text);
  if (!match) throw new Flat(`unsupported pattern: condition text of ${statement.op}`);
  return match[1];
}

/**
 * Blocks with resolved successors. Each block is
 * `{ body: number[], term: Statement|null, returns, succ: number[], cond, pushTarget }`:
 * `body` are the indexes of its non-control statements, `term` its closing control statement,
 * `cond` (for a conditional) `{ text, whenTrue, whenFalse }`, `pushTarget` the block a push
 * names. Block ids run from 0; `exit` (= blocks.length) stands for leaving the function.
 */
function buildGraph(statements) {
  const indexOfOffset = new Map(statements.map((s, i) => [s.offset, i]));
  const statementAt = (offset) => {
    const index = indexOfOffset.get(offset);
    if (index === undefined) throw new Flat("jump into the middle of a statement");
    return index;
  };

  const starts = new Set([0]);
  statements.forEach((s, i) => {
    if (TARGET_OPS.has(s.op)) starts.add(statementAt(s.target));
    if (CONTROL_OPS.has(s.op) || s.op === "EX_Return") starts.add(i + 1);
  });
  const sorted = [...starts].filter((i) => i < statements.length).sort((a, b) => a - b);
  const blockOfStatement = new Map(sorted.map((start, id) => [start, id]));

  const blocks = sorted.map((start, id) => {
    const end = id + 1 < sorted.length ? sorted[id + 1] : statements.length;
    const body = [];
    let term = null;
    let returns = false;
    for (let i = start; i < end; i += 1) {
      if (CONTROL_OPS.has(statements[i].op)) term = statements[i];
      else body.push(i);
      if (statements[i].op === "EX_Return") returns = true;
    }
    return { body, term, returns, succ: [], cond: null, pushTarget: null, reached: false };
  });
  const exit = blocks.length;
  const blockAt = (offset) => blockOfStatement.get(statementAt(offset));
  resolveFlow(blocks, exit, blockAt);

  for (const block of blocks) {
    if (!block.reached && block.body.length) throw new Flat("unsupported pattern: unreachable statements");
  }
  const finalReturn = makeFinalReturnTheExit(statements, blocks, exit);
  return { blocks, exit, entry: blocks.length ? 0 : exit, finalReturn };
}

/**
 * Blueprint compiles every Return node to a jump to one closing `return` statement. When the
 * last block is only that statement, edges into it become edges to `exit`: a jump to it from
 * inside a branch is then an early return, and the statement itself is printed once at the end.
 * Returns the statement's index, or null when the function does not end that way.
 */
function makeFinalReturnTheExit(statements, blocks, exit) {
  const last = blocks.length - 1;
  if (last < 1) return null;
  const block = blocks[last];
  if (!block.reached || block.term !== null || block.body.length !== 1) return null;
  const statement = statements[block.body[0]];
  if (statement.op !== "EX_Return" || statement.text !== "return") return null;
  if (blocks.some((b) => b.pushTarget === last)) return null;
  const redirect = (id) => (id === last ? exit : id);
  for (const b of blocks) {
    b.succ = [...new Set(b.succ.map(redirect))];
    if (b.cond) {
      b.cond.whenTrue = redirect(b.cond.whenTrue);
      b.cond.whenFalse = redirect(b.cond.whenFalse);
    }
  }
  block.reached = false; // no longer part of the graph; its statement is emitted by `structure`
  block.succ = [];
  return block.body[0];
}

/**
 * Walks the blocks from the entry with the execution-flow stack each one is entered with, and
 * fills `succ`, `cond` and `pushTarget`. A pop goes to the block on top of the stack, or leaves
 * the function when the stack is empty.
 */
function resolveFlow(blocks, exit, blockAt) {
  if (!blocks.length) return;
  const entryStack = new Map();
  const work = [[0, []]];
  while (work.length) {
    const [id, stack] = work.pop();
    const key = stack.join(",");
    if (entryStack.has(id)) {
      if (entryStack.get(id) !== key) throw new Flat("unsupported pattern: flow stack differs between paths");
      continue;
    }
    entryStack.set(id, key);
    const block = blocks[id];
    block.reached = true;
    const next = id + 1 < blocks.length ? id + 1 : exit;
    const popped = () => (stack.length ? [stack[stack.length - 1], stack.slice(0, -1)] : [exit, stack]);
    const edges = []; // [block, stack]
    const op = block.term?.op;
    if (block.returns && block.term === null) edges.push([exit, stack]);
    else if (op === undefined) edges.push([next, stack]);
    else if (op === "EX_Jump") edges.push([blockAt(block.term.target), stack]);
    else if (op === "EX_JumpIfNot") {
      const whenFalse = blockAt(block.term.target);
      block.cond = { text: conditionOf(block.term), whenTrue: next, whenFalse };
      edges.push([next, stack], [whenFalse, stack]);
    } else if (op === "EX_PushExecutionFlow") {
      block.pushTarget = blockAt(block.term.target);
      if (stack.length >= MAX_FLOW_STACK) throw new Flat("unsupported pattern: unbounded flow stack");
      edges.push([next, [...stack, block.pushTarget]]);
    } else if (op === "EX_PopExecutionFlow") {
      edges.push(popped());
    } else if (op === "EX_PopExecutionFlowIfNot") {
      const [whenFalse, rest] = popped();
      block.cond = { text: conditionOf(block.term), whenTrue: next, whenFalse };
      edges.push([next, stack], [whenFalse, rest]);
    }
    block.succ = [...new Set(edges.map(([to]) => to))];
    for (const [to, toStack] of edges) if (to !== exit) work.push([to, toStack]);
  }
}

// --- 3: dominators, loops, post-dominators

/** Nodes reachable from `entry` in reverse postorder of an iterative depth-first search. */
function reversePostorder(entry, successors) {
  const order = [];
  const seen = new Set([entry]);
  const stack = [[entry, 0]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const next = successors(top[0]);
    if (top[1] < next.length) {
      const child = next[top[1]];
      top[1] += 1;
      if (!seen.has(child)) {
        seen.add(child);
        stack.push([child, 0]);
      }
    } else {
      order.push(top[0]);
      stack.pop();
    }
  }
  return order.reverse();
}

/**
 * Immediate dominators by the iterative algorithm of Cooper, Harvey and Kennedy. Returns
 * `{ idom, rank }`: `idom` maps each reachable node to its immediate dominator (the entry to
 * itself), `rank` maps it to its reverse-postorder position.
 */
function immediateDominators(entry, successors, predecessors) {
  const order = reversePostorder(entry, successors);
  const rank = new Map(order.map((node, i) => [node, i]));
  const idom = new Map([[entry, entry]]);
  const intersect = (a, b) => {
    while (a !== b) {
      while (rank.get(a) > rank.get(b)) a = idom.get(a);
      while (rank.get(b) > rank.get(a)) b = idom.get(b);
    }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const node of order) {
      if (node === entry) continue;
      let best;
      for (const p of predecessors(node)) {
        if (!idom.has(p)) continue;
        best = best === undefined ? p : intersect(p, best);
      }
      if (best !== undefined && idom.get(node) !== best) {
        idom.set(node, best);
        changed = true;
      }
    }
  }
  return { idom, rank };
}

/**
 * Adds `preds`, `loops` (header to `{ nodes }`, the natural loop) and `ipdom` (block to its
 * immediate post-dominator, which may be `exit`) to the graph. Throws for an irreducible graph.
 */
function analyse(graph) {
  const { blocks, exit, entry } = graph;
  if (entry === exit) {
    Object.assign(graph, { preds: [], loops: new Map(), ipdom: new Map(), rank: new Map() });
    return;
  }
  const succ = (n) => (n === exit ? [] : blocks[n].succ);
  const preds = Array.from({ length: exit + 1 }, () => []);
  blocks.forEach((block, id) => {
    if (block.reached) for (const s of block.succ) preds[s].push(id);
  });

  const { idom, rank } = immediateDominators(entry, succ, (n) => preds[n]);
  const dominates = (a, b) => {
    for (let n = b; ; n = idom.get(n)) {
      if (n === a) return true;
      if (n === entry) return false;
    }
  };

  // In a depth-first reverse postorder, an edge u -> v is retreating when v does not come
  // after u. A retreating edge is a loop's back edge only when v dominates u.
  const loops = new Map();
  for (const [u] of rank) {
    for (const v of succ(u)) {
      if (v === exit || rank.get(v) > rank.get(u)) continue;
      if (!dominates(v, u)) throw new Flat("irreducible control flow");
      if (!loops.has(v)) loops.set(v, { header: v, nodes: new Set([v]) });
      addNaturalLoop(loops.get(v).nodes, u, preds);
    }
  }

  // Post-dominators are dominators of the reversed graph, entered from `exit`.
  const post = immediateDominators(exit, (n) => preds[n], succ);
  const ipdom = new Map();
  for (const [node, dominator] of post.idom) if (node !== exit) ipdom.set(node, dominator);
  Object.assign(graph, { preds, loops, ipdom, rank });
}

/** Adds to `nodes` (which holds the header) every block that reaches `source` without the header. */
function addNaturalLoop(nodes, source, preds) {
  const work = [source];
  while (work.length) {
    const n = work.pop();
    if (nodes.has(n)) continue;
    nodes.add(n);
    work.push(...preds[n]);
  }
}

// --- 4: emitting lines

class Emitter {
  constructor(statements, graph) {
    this.statements = statements;
    this.graph = graph;
    this.blocks = graph.blocks;
    this.lines = [];
    this.emitted = new Set(); // statement indexes
    this.count = 0;
    this.emittedBlocks = new Set();
    this.stops = []; // the stop of every region being walked, innermost last
    this.openLoops = []; // loops being emitted, innermost last
  }

  line(depth, text) {
    this.lines.push("  ".repeat(depth) + text);
  }

  statement(index, depth) {
    if (this.emitted.has(index)) throw new Flat("statement count mismatch");
    this.emitted.add(index);
    this.count += 1;
    this.line(depth, this.statements[index].text);
  }

  /** Marks a block as emitted and writes its non-control statements. */
  blockBody(id, depth) {
    this.emittedBlocks.add(id);
    for (const index of this.blocks[id].body) this.statement(index, depth);
  }

  /**
   * Emits the code from block `start` up to, not including, block `stop`. A path that leaves
   * the function before reaching `stop` ends with a `return` line, unless the block it left
   * from already printed its own return statement.
   */
  region(start, stop, depth) {
    this.stops.push(stop);
    let node = start;
    let returned = false;
    while (node !== stop) {
      if (node === this.graph.exit) {
        if (!returned) this.line(depth, "return");
        break;
      }
      this.checkInside(node);
      const isNewLoop = this.graph.loops.has(node) && !this.openLoops.some((loop) => loop.header === node);
      returned = !isNewLoop && this.blocks[node].returns;
      node = isNewLoop ? this.loop(node, depth) : this.block(node, stop, depth);
    }
    this.stops.pop();
  }

  /** A region may only reach blocks that are its own: not an outer stop, not outside its loop, not twice. */
  checkInside(node) {
    if (this.stops.includes(node)) throw new Flat("unsupported pattern: jump out of a block");
    const loop = this.openLoops[this.openLoops.length - 1];
    if (loop && !loop.nodes.has(node)) throw new Flat("unsupported pattern: loop with several exits");
    if (this.emittedBlocks.has(node)) throw new Flat("unsupported pattern: code reached from two places");
  }

  /** Emits one block and whatever structure its closing statement opens; returns the block after it. */
  block(id, stop, depth) {
    this.blockBody(id, depth);
    const block = this.blocks[id];
    if (block.pushTarget !== null) return this.sequence(id, stop, depth);
    if (block.cond) return this.conditional(id, depth);
    return block.succ[0];
  }

  /** `if (c) { ... } else { ... }` up to the conditional's immediate post-dominator. */
  conditional(id, depth) {
    const { text, whenTrue, whenFalse } = this.blocks[id].cond;
    const join = this.joinOf(id);
    if (whenFalse === join) {
      this.line(depth, `if (${text}) {`);
      this.region(whenTrue, join, depth + 1);
    } else if (whenTrue === join) {
      this.line(depth, `if (!(${text})) {`);
      this.region(whenFalse, join, depth + 1);
    } else {
      this.line(depth, `if (${text}) {`);
      this.region(whenTrue, join, depth + 1);
      this.line(depth, "} else {");
      this.region(whenFalse, join, depth + 1);
    }
    this.line(depth, "}");
    return join;
  }

  /**
   * Where the two branches of a conditional meet again. That is its immediate post-dominator,
   * unless that is the function's exit because some path returns early. Then a branch that
   * returns at once joins at the other branch's start, and otherwise the branches join at the
   * first block (in reverse postorder) both reach without leaving the current loop. A poor
   * choice cannot produce wrong output: the walk refuses any path that misses the join.
   */
  joinOf(id) {
    const { whenTrue, whenFalse } = this.blocks[id].cond;
    const { exit, ipdom, rank } = this.graph;
    const dominator = ipdom.get(id);
    if (dominator !== undefined && dominator !== exit) return dominator;
    if (whenFalse === exit) return whenTrue;
    if (whenTrue === exit) return whenFalse;
    const fromTrue = this.reachable(whenTrue);
    let best;
    for (const node of this.reachable(whenFalse)) {
      if (fromTrue.has(node) && (best === undefined || rank.get(node) < rank.get(best))) best = node;
    }
    if (best !== undefined) return best;
    if (dominator === undefined) throw new Flat("unsupported pattern: branch that never ends");
    return exit;
  }

  /** Blocks reachable from `start` without leaving the function, re-entering the current loop's header, or leaving that loop. */
  reachable(start) {
    const loop = this.openLoops[this.openLoops.length - 1];
    const seen = new Set();
    const work = [start];
    while (work.length) {
      const node = work.pop();
      if (node === this.graph.exit || seen.has(node) || this.emittedBlocks.has(node)) continue;
      if (loop && (node === loop.header || !loop.nodes.has(node))) continue;
      seen.add(node);
      work.push(...this.blocks[node].succ);
    }
    return seen;
  }

  /**
   * A Blueprint Sequence: pushes of X1..Xk, then the first chain. The first chain pops to Xk,
   * the chain at Xk pops to X(k-1), and so on; the chain at X1 ends at the enclosing region's
   * stop. Each chain is one block, printed in execution order.
   */
  sequence(id, stop, depth) {
    const targets = [this.blocks[id].pushTarget];
    let next = this.blocks[id].succ[0];
    while (this.isBarePush(next)) {
      this.emittedBlocks.add(next);
      targets.push(this.blocks[next].pushTarget);
      next = this.blocks[next].succ[0];
    }
    const starts = [next, ...targets.reverse()];
    const stops = [...starts.slice(1), stop];
    starts.forEach((start, i) => {
      this.line(depth, `// sequence ${i + 1}`);
      this.region(start, stops[i], depth + 1);
    });
    return stop;
  }

  /** A block that only pushes and is entered only from the block before it. */
  isBarePush(id) {
    if (id === this.graph.exit) return false;
    const block = this.blocks[id];
    return block.pushTarget !== null && block.body.length === 0 && this.graph.preds[id].length === 1;
  }

  /**
   * A loop whose only exit is a conditional reached from the header in straight-line code.
   * With nothing before that conditional it is `while (c) { body }`; otherwise the statements
   * computing the condition stay first: `while (true) { s; if (!(c)) break; body }`.
   */
  loop(header, depth) {
    const loop = this.graph.loops.get(header);
    const { exit } = this.graph;
    // The loop's follow: the one block outside the loop that it continues at. Edges to `exit`
    // are returns, allowed anywhere; with no other way out, the loop's exit is a return.
    const follows = new Set();
    for (const n of loop.nodes) {
      for (const s of this.blocks[n].succ) if (s !== exit && !loop.nodes.has(s)) follows.add(s);
    }
    if (follows.size > 1) throw new Flat("unsupported pattern: loop with several exits");
    const exitTarget = follows.size ? [...follows][0] : exit;

    const chain = [];
    let node = header;
    for (;;) {
      const block = this.blocks[node];
      if (block.cond && block.cond.whenTrue !== block.cond.whenFalse && block.succ.includes(exitTarget)) break;
      if (block.succ.some((s) => !loop.nodes.has(s))) throw new Flat("unsupported pattern: loop exit that is not a condition");
      if (block.cond || block.pushTarget !== null) throw new Flat("unsupported pattern: loop exit after a branch");
      chain.push(node);
      node = block.succ[0];
      if (node === header) throw new Flat("unsupported pattern: loop without exit");
      if (this.graph.loops.has(node)) throw new Flat("unsupported pattern: loop exit after an inner loop");
    }
    const exitBlock = node;
    for (const n of loop.nodes) {
      if (n !== exitBlock && exitTarget !== exit && this.blocks[n].succ.includes(exitTarget)) {
        throw new Flat("unsupported pattern: loop with several exits");
      }
    }
    const { text, whenTrue, whenFalse } = this.blocks[exitBlock].cond;
    const staysWhenTrue = whenFalse === exitTarget;
    const inside = staysWhenTrue ? whenTrue : whenFalse;

    this.openLoops.push(loop);
    if (chain.length === 0 && this.blocks[header].body.length === 0) {
      this.emittedBlocks.add(header);
      this.line(depth, `while (${staysWhenTrue ? text : `!(${text})`}) {`);
    } else {
      this.line(depth, "while (true) {");
      for (const n of [...chain, exitBlock]) this.blockBody(n, depth + 1);
      this.line(depth + 1, `if (${staysWhenTrue ? `!(${text})` : text}) break`);
    }
    this.region(inside, header, depth + 1);
    this.line(depth, "}");
    this.openLoops.pop();
    return exitTarget;
  }
}

import * as fs from "fs";
import * as path from "path";

/**
 * Keeps a seat's shell from landing work on the product branch behind the mesh's back.
 *
 * `git.merge` is a capability, the `merge` op enforces it and the `patch.merge` gate,
 * and the op records the landing: `patch.merged`, the MERGED transition,
 * `implementation-merged`. A seat with test or shell access can run the same `git
 * merge` in the product checkout from its own Bash, and then none of that applies --
 * no capability check, no gate, no event. In the cronlite run the developer, which
 * held no `git.merge`, ran `cd <workspace>/main && git merge mesh/developer` and the
 * product branch moved 49 s before the tech lead's proper `mesh_merge`; in the next
 * run it also tried `git push -f origin mesh/developer:main`. Nothing on the log said
 * either happened, and the PM accepted a merged criterion from `git log`.
 *
 * This is the half of the boundary the permission gate can state without a sandbox:
 * git commands that run IN the product checkout may only read it, and `git push`
 * needs `git.merge`. A git command in the seat's own worktree is untouched -- merging
 * `main` into its own branch is ordinary work -- and so is everything that is not git.
 * It reads the command text, so it stops the move a helpful model makes by reflex,
 * not a seat determined to get around it. Shell writes (`cp`, redirection) are a
 * different boundary and are not drawn here; the file tools' are (`productWriteDenial`).
 */

/** git subcommands that only read. Anything else run in the product checkout is refused. */
const READ_ONLY_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "blame", "shortlog",
  "describe", "grep", "reflog", "show-ref", "for-each-ref", "name-rev", "merge-base", "diff-tree", "diff-files", "diff-index",
  "whatchanged", "count-objects", "check-ignore", "var", "version", "help",
]);

/** Flags that make `git branch` / `git tag` a listing rather than a move or a delete. */
const LISTING_FLAGS = new Set(["-l", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort"]);

/** Words that run their arguments as a command without being the command. */
const WRAPPERS = new Set(["env", "command", "exec", "time", "nohup", "nice", "stdbuf"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

export interface LandingScope {
  /** The seat's own directory: where an un-`cd`'d command runs. */
  cwd: string;
  /** The product checkout, which work reaches only through the `merge` op. */
  productPath: string;
}

export interface LandingSeat {
  /** Holds `git.merge`: may `git push`. It may not change the product checkout from a shell either way. */
  mayPush: boolean;
}

interface Word {
  text: string;
  /** Contained an expansion (`$`, backticks, `*`, `~`) the text alone cannot resolve. */
  dynamic: boolean;
}

/**
 * What a lifted substitution leaves in the text of the command around it.
 *
 * `$PWD` for one that only asks where the shell is (`$(pwd)`), which is what it evaluates to and
 * what `expandHere` can place; an unknown for anything else, which only a shell could evaluate.
 */
function standIn(body: string): string {
  return /^\s*pwd(\s+-[LP])?\s*$/.test(body) ? "$PWD" : "$SUBST";
}

/** Split `command` into simple commands on unquoted control operators, and lift `$(...)`/backtick bodies out as commands of their own. */
function simpleCommands(command: string, into: string[] = []): string[] {
  let current = "";
  let quote: '"' | "'" | null = null;
  // Inside an unquoted `${...}`, whose braces are a word's and not a block's.
  let expansion = 0;
  const flush = (): void => {
    if (current.trim()) into.push(current.trim());
    current = "";
    expansion = 0;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      current += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    // A substitution runs whether or not it is quoted (only single quotes stop it).
    if (c === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth > 0; j++) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") depth--;
      }
      const body = command.slice(i + 2, j - 1);
      simpleCommands(body, into);
      current += standIn(body);
      i = j - 1;
      continue;
    }
    if (c === "`") {
      const end = command.indexOf("`", i + 1);
      const stop = end === -1 ? command.length : end;
      const body = command.slice(i + 1, stop);
      simpleCommands(body, into);
      current += standIn(body);
      i = stop;
      continue;
    }
    if (quote === null && c === "$" && command[i + 1] === "{") {
      expansion++;
      current += "${";
      i++;
      continue;
    }
    if (quote === null && expansion > 0 && (c === "{" || c === "}")) {
      expansion += c === "{" ? 1 : -1;
      current += c;
      continue;
    }
    if (quote === '"') {
      current += c;
      if (c === '"') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "{" || c === "}") {
      flush();
      continue;
    }
    current += c;
  }
  flush();
  return into;
}

/** Words of one simple command, quotes removed. */
function wordsOf(simple: string): Word[] {
  const out: Word[] = [];
  let text = "";
  let dynamic = false;
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const push = (): void => {
    if (inWord) out.push({ text, dynamic });
    text = "";
    dynamic = false;
    inWord = false;
  };
  for (let i = 0; i < simple.length; i++) {
    const c = simple[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else text += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < simple.length) text += simple[++i];
      else {
        if (c === "$" || c === "`") dynamic = true;
        text += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "\\" && i + 1 < simple.length) {
      text += simple[++i];
      inWord = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === "$" || c === "`" || c === "*" || c === "?" || (c === "~" && !inWord)) dynamic = true;
    text += c;
    inWord = true;
  }
  push();
  return out;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function within(dir: string | undefined, root: string): boolean {
  if (dir === undefined) return false;
  const a = realOrResolved(dir);
  const b = realOrResolved(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Where a `cd` / `-C` argument that expands points, when the text alone can say.
 *
 * One expansion names a place the gate already knows: the directory the command is in, as
 * `$PWD`, `${PWD}` or `$(pwd)` (which `standIn` rewrites to `$PWD`), alone or as the start of a
 * path (`$PWD/..`). Anything else that expands (another variable, `$(dirname ...)`, a glob) is
 * for the shell to decide, and so is `$PWD` once the command has assigned it or does not know
 * where it is.
 *
 * The second cronlite run's developer wrote `cd "$(pwd)" && git merge main` to bring main into
 * its own branch, which is ordinary work, and was told it could not say where that merge ran.
 */
function expandHere(w: Word, cwd: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (cwd === undefined || "PWD" in env) return undefined;
  const lead = /^(?:\$\{PWD\}|\$PWD(?![A-Za-z0-9_]))/.exec(w.text);
  if (!lead) return undefined;
  const tail = w.text.slice(lead[0].length);
  if (/[$`*?]/.test(tail)) return undefined;
  return path.resolve(cwd + tail);
}

/**
 * Why `command` may not run, or null if it may.
 *
 * Tracks the directory a command runs in through literal `cd` and `git -C`, and the
 * `GIT_DIR` / `GIT_WORK_TREE` a preceding assignment points git at. A directory it
 * cannot resolve (a variable, a substitution) is unknown, and an unknown directory
 * is refused only for `git merge`: the worktree is the common, legitimate target of
 * `cd "$(git rev-parse --show-toplevel)"`, and a blanket refusal would fail every
 * such commit to catch the one move this exists for. The current directory is not
 * unknown however it is spelled: see `expandHere`.
 */
export function landingDenial(command: string, scope: LandingScope, seat: LandingSeat): string | null {
  return scan(command, scope, seat, { cwd: scope.cwd, env: {} }, 0);
}

/**
 * Why a file tool may not write `target`, or null if it may.
 *
 * `landingDenial` keeps a seat's SHELL from changing the product branch. The file tools were the other
 * door, and nothing guarded it: the seventh cronlite run's developer, its session resumed after a crash,
 * edited `src/index.js` and `test/index.test.js` by the absolute path of the product checkout (thirteen
 * Edit calls, twelve of them landed) instead of its own worktree's. The files changed on no branch, no
 * reviewer saw them, and every `merge` after that failed on "your local changes would be overwritten", six
 * times; the seats spent nearly eight minutes and two
 * escalation cards asking one another to commit changes that were not theirs, until the operator reset the
 * checkout by hand.
 *
 * A write is refused when its target resolves inside the product checkout and the seat's own directory is
 * not that checkout (a mesh without worktrees works in it, and that is ordinary). A target that does not
 * exist yet is resolved through its nearest existing parent, so a new file, or a path through a symlink, is
 * held to the same rule. Reads never reach this: `Read`, `Glob` and `Grep` are not file-writing tools.
 */
export function productWriteDenial(target: string, scope: LandingScope): string | null {
  if (!target) return null;
  if (within(scope.cwd, scope.productPath)) return null;
  const absolute = path.resolve(scope.cwd, target);
  if (!within(resolveForWrite(absolute), scope.productPath)) return null;
  return (
    `\`${target}\` is in the product checkout (${scope.productPath}), which changes only through the \`merge\` op: a file written there is on no branch, no reviewer has seen it, and it makes every later merge fail. ` +
    `Write the file in your own worktree (${scope.cwd}), commit it there, and let the merge land it`
  );
}

/** The real path of `p` even when it does not exist yet: the nearest existing parent, resolved, with the rest appended. */
function resolveForWrite(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return p;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realOrResolved(existing), ...rest);
}

interface ShellState {
  /** `undefined`: a `cd` the text cannot resolve. */
  cwd: string | undefined;
  env: Record<string, string | undefined>;
}

function scan(command: string, scope: LandingScope, seat: LandingSeat, state: ShellState, depth: number): string | null {
  if (depth > 4) return null;
  for (const simple of simpleCommands(command)) {
    const words = wordsOf(simple);
    let i = 0;
    const env: Record<string, string | undefined> = { ...state.env };
    // Leading assignments and the wrappers that only run what follows.
    for (;;) {
      const w = words[i];
      if (!w) break;
      if (ASSIGNMENT.test(w.text)) {
        const eq = w.text.indexOf("=");
        env[w.text.slice(0, eq)] = w.dynamic ? undefined : w.text.slice(eq + 1);
        i++;
        continue;
      }
      if (WRAPPERS.has(w.text)) {
        i++;
        while (words[i] && (words[i]!.text.startsWith("-") || ASSIGNMENT.test(words[i]!.text))) {
          if (ASSIGNMENT.test(words[i]!.text)) {
            const eq = words[i]!.text.indexOf("=");
            env[words[i]!.text.slice(0, eq)] = words[i]!.dynamic ? undefined : words[i]!.text.slice(eq + 1);
          }
          i++;
        }
        continue;
      }
      break;
    }
    const head = words[i];
    if (!head) {
      // A bare assignment (`GIT_DIR=x`, `export GIT_DIR=x` below) is shell state for what follows.
      Object.assign(state.env, env);
      continue;
    }
    const name = path.basename(head.text);
    const rest = words.slice(i + 1);

    if (name === "export") {
      for (const w of rest) {
        if (ASSIGNMENT.test(w.text)) {
          const eq = w.text.indexOf("=");
          state.env[w.text.slice(0, eq)] = w.dynamic ? undefined : w.text.slice(eq + 1);
        }
      }
      continue;
    }
    if (name === "cd" || name === "pushd") {
      const target = rest.find((w) => !w.text.startsWith("-"));
      if (!target || target.text === "-") state.cwd = undefined;
      else if (target.dynamic) state.cwd = expandHere(target, state.cwd, env);
      else state.cwd = path.resolve(state.cwd ?? scope.cwd, target.text);
      continue;
    }
    if (SHELLS.has(name)) {
      const c = rest.findIndex((w) => w.text === "-c" || /^-[a-z]*c[a-z]*$/.test(w.text));
      const body = c >= 0 ? rest[c + 1] : undefined;
      if (body) {
        const inner = scan(body.text, scope, seat, { cwd: state.cwd, env: { ...state.env, ...env } }, depth + 1);
        if (inner) return inner;
      }
      continue;
    }
    if (name === "eval") {
      const inner = scan(rest.map((w) => w.text).join(" "), scope, seat, { cwd: state.cwd, env: { ...state.env, ...env } }, depth + 1);
      if (inner) return inner;
      continue;
    }
    if (name !== "git") continue;

    // Global options, up to the subcommand.
    let dir: string | undefined = state.cwd;
    let gitDir = env.GIT_DIR;
    let workTree = env.GIT_WORK_TREE;
    let j = 0;
    for (; j < rest.length; j++) {
      const t = rest[j]!;
      if (t.text === "-C") {
        const next = rest[++j];
        if (!next) dir = undefined;
        else if (next.dynamic) dir = expandHere(next, dir, env);
        else dir = path.resolve(dir ?? scope.cwd, next.text);
      } else if (t.text === "-c" || t.text === "--namespace" || t.text === "--exec-path") {
        j++;
      } else if (t.text === "--git-dir" || t.text === "--work-tree") {
        const next = rest[++j];
        const value = next && !next.dynamic ? path.resolve(dir ?? scope.cwd, next.text) : undefined;
        if (t.text === "--git-dir") gitDir = value;
        else workTree = value;
      } else if (t.text.startsWith("--git-dir=")) {
        gitDir = t.dynamic ? undefined : path.resolve(dir ?? scope.cwd, t.text.slice("--git-dir=".length));
      } else if (t.text.startsWith("--work-tree=")) {
        workTree = t.dynamic ? undefined : path.resolve(dir ?? scope.cwd, t.text.slice("--work-tree=".length));
      } else if (t.text.startsWith("-")) {
        continue;
      } else break;
    }
    const sub = rest[j]?.text;
    if (!sub) continue;
    const args = rest.slice(j + 1).map((w) => w.text);

    // Where it runs: an explicit work tree, else the directory holding the git dir's checkout, else the cwd.
    const runsIn = workTree ?? (gitDir ? path.dirname(gitDir) : dir);
    const inProduct = within(runsIn, scope.productPath) || within(gitDir, path.join(scope.productPath, ".git"));

    if (sub === "push" && !seat.mayPush) {
      return "`git push` publishes work outside the review ladder, and pushing needs git.merge — commit in your own worktree and let the seat that holds git.merge land the approved patch with the `merge` op";
    }
    if (inProduct && !isReadOnly(sub, args)) {
      return (
        `\`git ${sub}\` would change the product checkout (${scope.productPath}). Work reaches it only through the \`merge\` op, which checks git.merge and the merge gate and records the landing; ` +
        `a shell command does none of that and leaves no event. Commit in your own worktree (${scope.cwd}) and ` +
        (seat.mayPush ? "use the `merge` op once the patch is approved" : "let the seat that holds git.merge run the `merge` op once the patch is approved")
      );
    }
    if (!inProduct && runsIn === undefined && sub === "merge") {
      return "cannot tell from the command which directory this `git merge` runs in (a variable or substitution decides it), and a merge into the product checkout is not allowed from a shell — spell the directory out as a literal path, or use the `merge` op";
    }
  }
  return null;
}

function isReadOnly(sub: string, args: string[]): boolean {
  if (READ_ONLY_SUBCOMMANDS.has(sub)) return true;
  // `branch` and `tag` list with no arguments or only listing flags; anything else moves or deletes one.
  if (sub === "branch" || sub === "tag") return args.every((a) => LISTING_FLAGS.has(a.split("=")[0]!) || a === "");
  return false;
}

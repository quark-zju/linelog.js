/*

Copyright (c) 2020 Jun Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import { LineLog } from './linelog';
import { spawn } from 'node:child_process';
import { Mutex } from 'async-mutex';
const kDefaultLogOptions = {
    followRenames: true,
    firstParent: true,
};
// Log history of a file.
const logFile = async (gitRoot, path, options = kDefaultLogOptions) => {
    let args = [
        `--git-dir=${gitRoot}/.git`,
        "log",
        "--topo-order",
        "--format=format:%H",
        "--name-only",
    ];
    if (options.firstParent) {
        args.push("--first-parent");
    }
    if (options.followRenames) {
        args.push("--follow");
    }
    if (options.startingCommit) {
        args.push(options.startingCommit);
    }
    args = args.concat(["--", path]);
    const logOutput = await runGit(args);
    const result = [];
    let State;
    (function (State) {
        State[State["COMMIT"] = 0] = "COMMIT";
        State[State["PATH"] = 1] = "PATH";
        State[State["NEWLINE"] = 2] = "NEWLINE";
    })(State || (State = {}));
    let commit = "";
    let state = State.COMMIT;
    for (const line of logOutput.split(/\r?\n/)) {
        switch (state) {
            case State.COMMIT:
                if (line.length === 40) {
                    commit = line;
                    state = State.PATH;
                }
                break;
            case State.PATH:
                if (line.length > 0) {
                    result.push({ commit, path: line });
                    state = State.NEWLINE;
                }
                else {
                    state = State.COMMIT;
                }
                break;
            case State.NEWLINE:
                if (line === "") {
                    state = State.COMMIT;
                }
                break;
        }
    }
    return result;
};
// Read git object via `git cat-file --batch`.
class GitObjectReader {
    constructor(root) {
        this.root = root;
        this.process = null;
        this.mtime = Date.now();
        this.mutex = new Mutex();
    }
    // Stop background process.
    cleanUp() {
        if (this.process) {
            const process = this.process;
            process.stdin?.end();
            process.kill();
            this.process = null;
        }
    }
    async readObject(spec, expectedType = null) {
        return this.withProcess(async (proc) => {
            if (proc.stdout === null || proc.stdin === null) {
                throw new Error("stdout and stdin should not be null");
            }
            const stdout = proc.stdout;
            const stdin = proc.stdin;
            return await new Promise((rawResolve, rawReject) => {
                const finalize = () => {
                    stdout.removeAllListeners('data');
                    stdout.removeAllListeners('close');
                };
                const resolve = (data) => { finalize(); rawResolve(data); };
                const reject = (err) => { finalize(); rawReject(err); };
                let buf = Buffer.alloc(0);
                stdout.on('data', (chunk) => {
                    buf = Buffer.concat([buf, chunk]);
                    const newLinePos = buf.indexOf("\n");
                    if (newLinePos < 0) {
                        // always wait for reading the first line
                        return;
                    }
                    const firstLine = buf.slice(0, newLinePos).toString();
                    if (firstLine.indexOf("missing") >= 0) {
                        return reject(new Error(`object ${spec} is missing (${firstLine})`));
                    }
                    const [, type, lenStr] = firstLine.split(" ");
                    if (expectedType && expectedType !== type) {
                        return reject(new Error(`object ${spec} has type ${type}, which does not match expected ${expectedType}`));
                    }
                    const len = parseInt(lenStr);
                    const expectedLen = len + newLinePos + 1 /* LF */;
                    if (buf.length >= expectedLen + 1 /* LF */) {
                        return resolve(buf.slice(newLinePos + 1, expectedLen));
                    }
                }).on('close', () => {
                    reject(new Error(`object ${spec} cannot be read because git has closed its stdout`));
                });
                stdin.write(`${spec}\n`);
            });
        });
    }
    async getCommit(commit) {
        const buf = await this.readObject(commit, "commit");
        const text = buf.toString();
        let author = "unknown";
        let message = "";
        let timestamp = 0;
        let State;
        (function (State) {
            State[State["HEADER"] = 0] = "HEADER";
            State[State["BODY"] = 1] = "BODY";
        })(State || (State = {}));
        let state = State.HEADER;
        for (const line of text.split("\n")) {
            if (state === State.HEADER) {
                if (line.startsWith("author ")) {
                    // ex. "author Jun Wu <quark@example.com> 1591595522 -0700"
                    const parts = line.split(" ");
                    timestamp = parseInt(parts[parts.length - 2]);
                    author = parts.slice(1, parts.length - 2).join(" ");
                }
                else if (line.startsWith("committer ")) {
                    state = State.BODY;
                }
            }
            else if (state === State.BODY) {
                message += line + "\n";
            }
        }
        return {
            commit,
            author,
            message: message.trim(),
            timestamp,
        };
    }
    async catFile(commit, path) {
        const buf = await this.readObject(`${commit}:${path}`, "blob");
        return buf.toString();
    }
    async withProcess(callback) {
        return this.mutex.runExclusive(async () => {
            this.mtime = Date.now();
            let process = this.process;
            if (process === null) {
                const args = ["--git-dir", `${this.root}/.git`, "cat-file", "--batch"];
                const opts = { stdio: ["pipe", "pipe", "ignore"] };
                process = spawn("git", args, opts);
                this.process = process;
                this.scheduleAutoCleanUp();
            }
            return await callback(process);
        });
    }
    autoCleanUp() {
        if (this.process !== null) {
            this.mutex.runExclusive(async () => {
                if (Date.now() - this.mtime < 1100) {
                    this.scheduleAutoCleanUp();
                }
                else {
                    this.cleanUp();
                }
            });
        }
    }
    scheduleAutoCleanUp() {
        setTimeout(this.autoCleanUp.bind(this), 250);
    }
}
// Import Git history of a file to a LineLog.
const buildLineLogFromGitHistory = async (gitRoot, path, logOptions) => {
    const log = new LineLog();
    const options = { ...kDefaultLogOptions, ...(logOptions || {}) };
    let history = await logFile(gitRoot, path, options);
    if (history.length === 0 && !logOptions?.firstParent) {
        // Sometimes the history is empty with --follow and --first-parent.
        // Likely a bug in git. For now let's just workaround it by removing
        // --first-parent if the callsite does not explicitly set it.
        options.firstParent = false;
        history = await logFile(gitRoot, path, options);
    }
    const reader = new GitObjectReader(gitRoot);
    try {
        for (const { commit, path } of history.reverse()) {
            try {
                const text = await reader.catFile(commit, path);
                const commitInfo = await reader.getCommit(commit);
                const info = {
                    commit: commitInfo,
                    path,
                };
                log.recordText(text, commitInfo.timestamp * 1000, info);
            }
            catch {
                // Ignore missing objects.
                continue;
            }
        }
    }
    finally {
        reader.cleanUp();
    }
    return log;
};
// Run git process capture its output.
const runGit = async (args, options = null) => {
    const opts = options || {};
    opts.stdio = ["ignore", "pipe", "ignore"];
    const git = spawn("git", args, opts);
    let data = "";
    if (git.stdout !== null) {
        for await (const chunk of git.stdout) {
            data += chunk;
        }
    }
    const exitCode = await new Promise((resolve, reject) => {
        git.on("exit", resolve);
        git.on("error", reject);
    });
    if (exitCode === 0) {
        return data;
    }
    else {
        throw new Error(`git ${args.join(" ")} exited with ${exitCode}`);
    }
};
export { buildLineLogFromGitHistory, logFile, runGit, kDefaultLogOptions, GitObjectReader, };
//# sourceMappingURL=git.js.map
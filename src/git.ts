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
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { Writable, Readable } from 'stream';
import { Mutex } from 'async-mutex';

interface CommitPath {
    commit: string,
    path: string,
};

interface CommitInfo {
    commit: string,
    message: string,
    author: string,
    timestamp: number,
}

interface CommitPathInfo {
    commit: CommitInfo,
    path: string,
}

interface LogOptions {
    followRenames: boolean | null;
    firstParent: boolean | null;
    startingCommit: string | null;
}

const kDefaultLogOptions: LogOptions = {
    followRenames: true,
    firstParent: true,
    startingCommit: null,
};

// Log history of a file.
let logFile = async (gitRoot: string, path: string, options: LogOptions = kDefaultLogOptions): Promise<CommitPath[]> => {
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
    let logOutput = await runGit(args);
    let result = [];
    enum State {
        COMMIT = 0,
        PATH = 1,
        NEWLINE = 2,
    }
    let commit: string = "";
    let state: State = State.COMMIT;
    for (const line of logOutput.split(/\r?\n/)) {
        switch (state as State) {
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
                } else {
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
    root: string;
    process: null | ChildProcess;
    mtime: number;
    mutex: Mutex;

    constructor(root: string) {
        this.root = root;
        this.process = null;
        this.mtime = Date.now();
        this.mutex = new Mutex();
    }

    // Stop background process.
    cleanUp() {
        if (this.process) {
            let process = this.process;
            process.stdin?.end();
            process.kill();
            this.process = null;
        }
    }

    async readObject(spec: string, expectedType: string | null = null): Promise<Buffer> {
        return this.withProcess(async (proc) => {
            if (proc.stdout === null || proc.stdin === null) { throw new Error("stdout and stdin should not be null"); }
            let stdout: Readable = proc.stdout;
            let stdin: Writable = proc.stdin;
            return await new Promise((rawResolve, rawReject) => {
                let finalize = () => {
                    stdout.removeAllListeners('data');
                    stdout.removeAllListeners('close');
                };
                let resolve = (data: Buffer) => { finalize(); rawResolve(data); };
                let reject = (err: Error) => { finalize(); rawReject(err); };
                let buf = Buffer.alloc(0);
                stdout.on('data', (chunk) => {
                    buf = Buffer.concat([buf, chunk]);
                    let newLinePos = buf.indexOf("\n");
                    if (newLinePos < 0) {
                        // always wait for reading the first line
                        return;
                    }
                    let firstLine = buf.slice(0, newLinePos).toString();
                    if (firstLine.indexOf("missing") >= 0) {
                        return reject(new Error(`object ${spec} is missing (${firstLine})`));
                    }
                    let [oid, type, lenStr] = firstLine.split(" ");
                    if (expectedType && expectedType !== type) {
                        return reject(new Error(`object ${spec} has type ${type}, which does not match expected ${expectedType}`));
                    }
                    let len = parseInt(lenStr);
                    let expectedLen = len + newLinePos + 1 /* LF */;
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

    async getCommit(commit: string): Promise<CommitInfo> {
        let buf = await this.readObject(commit, "commit");
        let text = buf.toString();
        let author = "unknown";
        let message = "";
        let timestamp = 0;
        enum State {
            HEADER = 0,
            BODY = 1,
        }
        let state = State.HEADER;
        for (const line of text.split("\n")) {
            if (state === State.HEADER) {
                if (line.startsWith("author ")) {
                    // ex. "author Jun Wu <quark@example.com> 1591595522 -0700"
                    let parts = line.split(" ");
                    timestamp = parseInt(parts[parts.length - 2]);
                    author = parts.slice(1, parts.length - 2).join(" ");
                } else if (line.startsWith("committer ")) {
                    state = State.BODY;
                }
            } else if (state === State.BODY) {
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

    async catFile(commit: string, path: string): Promise<string> {
        let buf = await this.readObject(`${commit}:${path}`, "blob");
        return buf.toString();
    }

    private async withProcess<T>(callback: WithProcessCallback<T>): Promise<T> {
        return this.mutex.runExclusive(async () => {
            this.mtime = Date.now();
            let process = this.process;
            if (process === null) {
                const args = ["--git-dir", `${this.root}/.git`, "cat-file", "--batch"];
                const opts: SpawnOptions = { stdio: ["pipe", "pipe", "ignore"] };
                process = spawn("git", args, opts);
                this.process = process;
                this.scheduleAutoCleanUp();
            }
            return await callback(process);
        });
    }

    private autoCleanUp() {
        if (this.process !== null) {
            if (Date.now() - this.mtime < 1200) {
                this.scheduleAutoCleanUp();
            } else {
                this.cleanUp();
            }
        }
    }

    private scheduleAutoCleanUp() {
        setTimeout(this.autoCleanUp.bind(this), 250);
    }
}

interface WithProcessCallback<T> {
    (process: ChildProcess): Promise<T>
}

// Import Git history of a file to a LineLog.
let buildLineLogFromGitHistory = async (gitRoot: string, path: string, startingCommit: null | string = null): Promise<LineLog> => {
    let log = new LineLog();
    let options = { ...kDefaultLogOptions, startingCommit };
    let history = await logFile(gitRoot, path, options);
    if (history.length === 0) {
        // Sometimes the history is empty with --follow and --first-parent.
        // Likely a bug in git. For now let's just workaround it by logging
        // again.
        options.firstParent = false;
        options.followRenames = true;
        history = await logFile(gitRoot, path, options);
    }
    let reader = new GitObjectReader(gitRoot);
    try {
        for (const { commit, path } of history.reverse()) {
            try {
                let text = await reader.catFile(commit, path);
                let commitInfo = await reader.getCommit(commit);

                let info: CommitPathInfo = {
                    commit: commitInfo,
                    path,
                };
                log.recordText(text, commitInfo.timestamp * 1000, info);
            } catch {
                // Ignore missing objects.
                continue;
            }
        }
    } finally {
        reader.cleanUp();
    }
    return log;
};

// Run git process capture its output.
let runGit = async (args: string[], options: SpawnOptions | null = null): Promise<string> => {
    let opts = options || {};
    opts.stdio = ["ignore", "pipe", "ignore"];
    let git = spawn("git", args, opts);
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
    } else {
        throw new Error(`git ${args.join(" ")} exited with ${exitCode}`);
    }
};

export {
    buildLineLogFromGitHistory,
    logFile,
    runGit,
    kDefaultLogOptions,
    CommitPathInfo,
    CommitInfo,
    GitObjectReader
};
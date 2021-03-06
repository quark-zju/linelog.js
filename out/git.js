"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitObjectReader = exports.kDefaultLogOptions = exports.runGit = exports.logFile = exports.buildLineLogFromGitHistory = void 0;
const linelog_1 = require("./linelog");
const child_process_1 = require("child_process");
const async_mutex_1 = require("async-mutex");
;
const kDefaultLogOptions = {
    followRenames: true,
    firstParent: true,
};
exports.kDefaultLogOptions = kDefaultLogOptions;
// Log history of a file.
let logFile = (gitRoot, path, options = kDefaultLogOptions) => __awaiter(void 0, void 0, void 0, function* () {
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
    let logOutput = yield runGit(args);
    let result = [];
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
});
exports.logFile = logFile;
// Read git object via `git cat-file --batch`.
class GitObjectReader {
    constructor(root) {
        this.root = root;
        this.process = null;
        this.mtime = Date.now();
        this.mutex = new async_mutex_1.Mutex();
    }
    // Stop background process.
    cleanUp() {
        var _a;
        if (this.process) {
            let process = this.process;
            (_a = process.stdin) === null || _a === void 0 ? void 0 : _a.end();
            process.kill();
            this.process = null;
        }
    }
    readObject(spec, expectedType = null) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.withProcess((proc) => __awaiter(this, void 0, void 0, function* () {
                if (proc.stdout === null || proc.stdin === null) {
                    throw new Error("stdout and stdin should not be null");
                }
                let stdout = proc.stdout;
                let stdin = proc.stdin;
                return yield new Promise((rawResolve, rawReject) => {
                    let finalize = () => {
                        stdout.removeAllListeners('data');
                        stdout.removeAllListeners('close');
                    };
                    let resolve = (data) => { finalize(); rawResolve(data); };
                    let reject = (err) => { finalize(); rawReject(err); };
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
            }));
        });
    }
    getCommit(commit) {
        return __awaiter(this, void 0, void 0, function* () {
            let buf = yield this.readObject(commit, "commit");
            let text = buf.toString();
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
                        let parts = line.split(" ");
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
        });
    }
    catFile(commit, path) {
        return __awaiter(this, void 0, void 0, function* () {
            let buf = yield this.readObject(`${commit}:${path}`, "blob");
            return buf.toString();
        });
    }
    withProcess(callback) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.mutex.runExclusive(() => __awaiter(this, void 0, void 0, function* () {
                this.mtime = Date.now();
                let process = this.process;
                if (process === null) {
                    const args = ["--git-dir", `${this.root}/.git`, "cat-file", "--batch"];
                    const opts = { stdio: ["pipe", "pipe", "ignore"] };
                    process = child_process_1.spawn("git", args, opts);
                    this.process = process;
                    this.scheduleAutoCleanUp();
                }
                return yield callback(process);
            }));
        });
    }
    autoCleanUp() {
        if (this.process !== null) {
            if (Date.now() - this.mtime < 1200) {
                this.scheduleAutoCleanUp();
            }
            else {
                this.cleanUp();
            }
        }
    }
    scheduleAutoCleanUp() {
        setTimeout(this.autoCleanUp.bind(this), 250);
    }
}
exports.GitObjectReader = GitObjectReader;
// Import Git history of a file to a LineLog.
let buildLineLogFromGitHistory = (gitRoot, path, logOptions) => __awaiter(void 0, void 0, void 0, function* () {
    let log = new linelog_1.LineLog();
    let options = Object.assign(Object.assign({}, kDefaultLogOptions), (logOptions || {}));
    let history = yield logFile(gitRoot, path, options);
    if (history.length === 0 && !(logOptions === null || logOptions === void 0 ? void 0 : logOptions.firstParent)) {
        // Sometimes the history is empty with --follow and --first-parent.
        // Likely a bug in git. For now let's just workaround it by removing
        // --first-parent if the callsite does not explicitly set it.
        options.firstParent = false;
        history = yield logFile(gitRoot, path, options);
    }
    let reader = new GitObjectReader(gitRoot);
    try {
        for (const { commit, path } of history.reverse()) {
            try {
                let text = yield reader.catFile(commit, path);
                let commitInfo = yield reader.getCommit(commit);
                let info = {
                    commit: commitInfo,
                    path,
                };
                log.recordText(text, commitInfo.timestamp * 1000, info);
            }
            catch (_a) {
                // Ignore missing objects.
                continue;
            }
        }
    }
    finally {
        reader.cleanUp();
    }
    return log;
});
exports.buildLineLogFromGitHistory = buildLineLogFromGitHistory;
// Run git process capture its output.
let runGit = (args, options = null) => __awaiter(void 0, void 0, void 0, function* () {
    var e_1, _b;
    let opts = options || {};
    opts.stdio = ["ignore", "pipe", "ignore"];
    let git = child_process_1.spawn("git", args, opts);
    let data = "";
    if (git.stdout !== null) {
        try {
            for (var _c = __asyncValues(git.stdout), _d; _d = yield _c.next(), !_d.done;) {
                const chunk = _d.value;
                data += chunk;
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (_d && !_d.done && (_b = _c.return)) yield _b.call(_c);
            }
            finally { if (e_1) throw e_1.error; }
        }
    }
    const exitCode = yield new Promise((resolve, reject) => {
        git.on("exit", resolve);
        git.on("error", reject);
    });
    if (exitCode === 0) {
        return data;
    }
    else {
        throw new Error(`git ${args.join(" ")} exited with ${exitCode}`);
    }
});
exports.runGit = runGit;
//# sourceMappingURL=git.js.map
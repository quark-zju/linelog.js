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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LineLog = exports.git = void 0;
const assert = require("assert");
const zlib = require("zlib");
const diff_match_patch = require("diff-match-patch");
const git = require("./git");
exports.git = git;
let dmp = new diff_match_patch.diff_match_patch;
var Op;
(function (Op) {
    Op[Op["J"] = 0] = "J";
    Op[Op["JGE"] = 1] = "JGE";
    Op[Op["JL"] = 2] = "JL";
    Op[Op["LINE"] = 3] = "LINE";
    Op[Op["END"] = 4] = "END";
})(Op || (Op = {}));
class LineLog {
    constructor() {
        this.code = [{ op: Op.END }];
        this.tsMap = {};
        this.extraMap = {};
        this.maxRev = 0;
        this.lastCheckoutRev = -1;
        this.lines = [];
        this.content = "";
        this.checkOut(0);
    }
    editChunk(a1, a2, rev, lines) {
        assert(a1 <= a2, "illegal chunk (a1 < a2)");
        assert(a2 <= this.lines.length, "out of bound a2 (forgot checkOut?)");
        let start = this.code.length;
        let a1Pc = this.lines[a1].pc;
        if (lines.length > 0) {
            let b2Pc = start + lines.length + 1;
            this.code.push({ op: Op.JL, rev, pc: b2Pc });
            lines.forEach((line) => {
                this.code.push({ op: Op.LINE, rev, data: line });
            });
            assert(b2Pc === this.code.length, "bug: wrong pc");
        }
        if (a1 < a2) {
            let a2Pc = this.lines[a2 - 1].pc + 1;
            this.code.push({ op: Op.JGE, rev, pc: a2Pc });
        }
        this.lines[a1].pc = this.code.length;
        this.code.push(Object.assign({}, this.code[a1Pc]));
        switch (this.code[a1Pc].op) {
            case Op.J:
            case Op.END: break;
            default: this.code.push({ op: Op.J, pc: a1Pc + 1 });
        }
        this.code[a1Pc] = { op: Op.J, pc: start };
        let newLines = lines.map((s, i) => { return { data: s, rev, pc: start + 1 + i, deleted: false }; });
        this.lines.splice(a1, a2 - a1, ...newLines);
        if (rev > this.maxRev) {
            this.maxRev = rev;
        }
        this.lastCheckoutRev = rev;
        // NOTE: this.content is not updated here. It should be updated by the call-site.
    }
    execute(startRev, endRev, present = null) {
        let rev = endRev;
        let lines = [];
        let pc = 0;
        let patience = this.code.length * 2;
        let deleted = present === null ? ((pc) => false) : (pc) => !present[pc];
        while (patience > 0) {
            let code = this.code[pc];
            switch (code.op) {
                case Op.END:
                    lines.push({ data: "", rev: 0, pc, deleted: deleted(pc) });
                    patience = -1;
                    break;
                case Op.LINE:
                    lines.push({ data: code.data, rev: code.rev, pc, deleted: deleted(pc) });
                    pc += 1;
                    break;
                case Op.J:
                    pc = code.pc;
                    break;
                case Op.JGE:
                    if (startRev >= code.rev) {
                        pc = code.pc;
                    }
                    else {
                        pc += 1;
                    }
                    break;
                case Op.JL:
                    if (rev < code.rev) {
                        pc = code.pc;
                    }
                    else {
                        pc += 1;
                    }
                    break;
                default:
                    assert(false, "bug: unknown code");
            }
            patience -= 1;
        }
        if (patience === 0) {
            assert(false, "bug: code does not end in time");
        }
        return lines;
    }
    checkOut(rev, start = null) {
        rev = Math.min(rev, this.maxRev);
        if (rev === this.lastCheckoutRev && start === null) {
            return;
        }
        else {
            this.lastCheckoutRev = rev;
        }
        let lines = this.execute(rev, rev);
        if (start !== null) {
            // Checkout a range, including deleted revs.
            let present = {};
            lines.forEach((l) => { present[l.pc] = true; });
            // Go through all lines again. But do not skip chunks.
            lines = this.execute(start, rev, present);
        }
        this.lines = lines;
        this.content = this.reconstructContent();
    }
    reconstructContent() {
        return this.lines.map((l) => l.data).join("");
    }
    export() {
        return zlib.gzipSync(JSON.stringify({ code: this.code, tsMap: this.tsMap, extraMap: this.extraMap }));
    }
    import(buf) {
        let obj = JSON.parse(zlib.gunzipSync(buf).toString());
        let { code, tsMap, extraMap } = obj;
        this.code = code;
        this.tsMap = tsMap || {};
        this.extraMap = extraMap || {};
        this.maxRev = Math.max(0, ...this.code.map((c) => (c.op === Op.JGE || c.op === Op.JL) ? c.rev : 0));
        this.checkOut(this.maxRev);
    }
    recordText(text, timestamp = null, extra = null) {
        let a = this.content;
        let b = text;
        if (a === b) {
            return this.maxRev;
        }
        let lines = splitLines(b);
        this.checkOut(this.maxRev);
        let blocks = diffLines(a, b);
        let ts = timestamp || Date.now();
        if (blocks.length === 1) {
            let rev = this.maxRev;
            let [a1, a2, b1, b2] = blocks[0];
            if (a2 - a1 === 1 && b2 - b1 === 1 && this.lines[a1].rev === rev && this.lines.filter((l) => l.rev === rev).length === 1) {
                // Trivial change. Update directly without keeping the old history.
                this.tsMap[rev] = ts;
                let code = this.code[this.lines[a1].pc];
                if (code.op === Op.LINE) {
                    let newLine = lines[b1];
                    code.data = newLine;
                    this.lines[a1].data = newLine;
                }
                else {
                    assert(false, "bug: inconsistent op");
                }
                this.content = b;
                return rev;
            }
        }
        // Non-trivial change.
        let rev = this.maxRev + 1;
        this.tsMap[rev] = ts;
        if (extra) {
            this.extraMap[rev] = extra;
        }
        blocks.reverse().forEach(([a1, a2, b1, b2]) => {
            this.editChunk(a1, a2, rev, lines.slice(b1, b2));
        });
        this.content = b;
        // assert(this.reconstructContent() === b, "bug: text does not match");
        return rev;
    }
    getLineTimestamp(i) {
        if (i >= this.lines.length - 1) {
            return 0;
        }
        else {
            let ts = this.tsMap[this.lines[i].rev];
            return ts;
        }
    }
    getLineExtra(i) {
        if (i >= this.lines.length - 1) {
            return {};
        }
        else {
            return this.extraMap[this.lines[i].rev] || {};
        }
    }
}
exports.LineLog = LineLog;
function diffLines(a, b) {
    let { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
    let blocks = [];
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0;
    let push = (len) => {
        if (a1 !== a2 || b1 !== b2) {
            blocks.push([a1, a2, b1, b2]);
        }
        a1 = a2 = a2 + len;
        b1 = b2 = b2 + len;
    };
    dmp.diff_main(chars1, chars2, false).forEach((x) => {
        let [op, chars] = x;
        let len = chars.length;
        if (op === 0) {
            push(len);
        }
        if (op < 0) {
            a2 += len;
        }
        if (op > 0) {
            b2 += len;
        }
    });
    push(0);
    return blocks;
}
function splitLines(s) {
    let pos = 0;
    let nextPos = 0;
    let result = [];
    while (pos < s.length) {
        nextPos = s.indexOf('\n', pos);
        if (nextPos === -1) {
            nextPos = s.length - 1;
        }
        result.push(s.slice(pos, nextPos + 1));
        pos = nextPos + 1;
    }
    return result;
}
;
//# sourceMappingURL=linelog.js.map
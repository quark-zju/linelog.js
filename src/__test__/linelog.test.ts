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

import { LineLog, git } from '../linelog';
import { describe, it, expect } from '@jest/globals';
import { dirname } from 'node:path';

describe('LineLog', () => {
    it('can be empty', () => {
        const log = new LineLog;
        expect(log.maxRev).toBe(0);
        expect(log.content).toBe("");
    });

    it('supports a single edit', () => {
        const log = new LineLog;
        log.recordText("c\nd\ne", 42);
        expect(log.maxRev).toBe(1);
        expect(log.content).toBe("c\nd\ne");
        expect(log.getLineTimestamp(0)).toBe(42);
        expect(log.getLineTimestamp(1)).toBe(42);
        expect(log.getLineTimestamp(2)).toBe(42);
        expect(log.getLineTimestamp(3)).toBe(0); // out of range
        expect(log.lines[0].deleted).toBe(false);
    });

    it('supports multiple edits', () => {
        const log = new LineLog;
        log.recordText("c\nd\ne\n", 42);
        log.recordText("d\ne\nf\n", 52);
        expect(log.maxRev).toBe(2);
        expect(log.content).toBe("d\ne\nf\n");
        expect(log.getLineTimestamp(0)).toBe(42);
        expect(log.getLineTimestamp(1)).toBe(42);
        expect(log.getLineTimestamp(2)).toBe(52);
        expect(log.getLineTimestamp(3)).toBe(0); // out of range
        expect(log.lines[0].deleted).toBe(false);
        expect(log.lines[2].deleted).toBe(false);
    });

    it('supports checkout', () => {
        const log = new LineLog;
        log.recordText("c\nd\ne\n", 42);
        log.recordText("d\ne\nf\n", 52);
        log.checkOut(1);
        expect(log.content).toBe("c\nd\ne\n");
        log.checkOut(0);
        expect(log.lines[0].deleted).toBe(false);
        expect(log.content).toBe("");
        expect(log.getLineTimestamp(0)).toBe(0);
        log.checkOut(2);
        expect(log.content).toBe("d\ne\nf\n");
        expect(log.lines[2].deleted).toBe(false);
    });

    it('supports checkout range', () => {
        const log = new LineLog;
        log.recordText("c\nd\ne\n", 42);
        log.recordText("d\ne\nf\n", 52);
        log.recordText("e\ng\nf\n", 62);

        log.checkOut(2, 1);
        expect(log.content).toBe("c\nd\ne\nf\n");
        expect(log.lines[0].deleted).toBeTruthy(); // 'c' not in rev 2
        expect(!log.lines[1].deleted).toBeTruthy(); // 'd' in rev 2
        expect(!log.lines[2].deleted).toBeTruthy();
        expect(!log.lines[3].deleted).toBeTruthy();

        log.checkOut(3, 0);
        expect(log.content).toBe("c\nd\ne\ng\nf\n");
        expect(log.lines[0].deleted).toBeTruthy(); // 'c' not in rev 3
        expect(log.lines[1].deleted).toBeTruthy(); // 'd' not in rev 3
        expect(!log.lines[2].deleted).toBeTruthy(); // 'e' in rev 3

        log.checkOut(3, 2);
        expect(log.content).toBe("d\ne\ng\nf\n");
        expect(log.lines[0].deleted).toBeTruthy(); // 'd' not in rev 3
        expect(!log.lines[1].deleted).toBeTruthy(); // 'e' in rev 3
        expect(!log.lines[3].deleted).toBeTruthy(); // 'f' in rev 3
    });

    it('supports export and import', () => {
        const log = new LineLog;
        log.recordText("c\nd\ne\n", 42);
        log.recordText("d\ne\nf\n", 52, { "foo": "bar" });
        const bytes = log.export();
        const log2 = new LineLog;
        log2.import(bytes);
        [1, 0, 2].forEach((i) => {
            log.checkOut(i);
            log2.checkOut(i);
            expect(log2.content).toBe(log.content);
            [0, 1, 2, 3].forEach((line) => {
                expect(log2.getLineTimestamp(line)).toBe(log2.getLineTimestamp(line));
                expect(log2.getLineExtra(line)).toEqual(log2.getLineExtra(line));
            });
        });
    });
});

if (!process.env.GITHUB_WORKFLOW) {
    // GitHub Workflow uses shallow checkouts, which is incompatible with the tests.
    const root = dirname(dirname(__dirname));

    describe('GitObjectReader', () => {
        const reader = new git.GitObjectReader(root);

        it('raises on missing objects', async () => {
            expect(async () => await reader.getCommit("ee5d18cd8203abb02cc559a9af601b4fbab58911")).rejects.toBeTruthy();
        });

        it('reads commits', async () => {
            const commit = await reader.getCommit("ee5d18cd8203abb02cc559a9af601b4fbab58910");
            expect(commit.author.split(" <")[0]).toBe("Jun Wu");
            expect(commit.timestamp).toBe(1591577310);
            expect(commit.message).toBe("Add README");
        });

        it('reads files', async () => {
            let content = await reader.catFile("94fbc0acec88bdfc08b751aee74043de124582a1", ".gitignore");
            expect(content).toBe(".vscode\r\nnode_modules\r\n");
            content = await reader.catFile("ef99d08bf2bdf5ee3976b0ec0621b4214a568337", "fixtures/a");
            expect(content).toBe("5\n6\n7\n");
        });
    });

    describe("Git -> LineLog", () => {
        it('imports files', async () => {
            const b = await git.buildLineLogFromGitHistory(root, "fixtures/b");
            expect(b.content).toBe("3\n5\n6\n7\n");
            expect((b.getLineExtra(0) as git.CommitPathInfo).commit.message).toBe("Edit fixtures/a");
            expect((b.getLineExtra(1) as git.CommitPathInfo).path).toBe("fixtures/b");
            expect((b.getLineExtra(2) as git.CommitPathInfo).path).toBe("fixtures/a");
            expect((b.getLineExtra(3) as git.CommitPathInfo).commit.timestamp).toBe(1592698681);
            expect(b.getLineTimestamp(3)).toBe(1592698681000);
            b.checkOut(b.maxRev, 0);
            expect(b.content).toBe("3\n4\n5\n5\n6\n7\n7\n8\n");
        });

        it('imports older files', async () => {
            const a = await git.buildLineLogFromGitHistory(
                root,
                "fixtures/a",
                { startingCommit: "a9ad1ca55280cea0f1109899d37d0cbb9b3efc1e" },
            );
            expect(a.content).toBe("3\n6\n7\n8\n");
            a.checkOut(a.maxRev, 0);
            expect(a.content).toBe("3\n4\n5\n6\n7\n7\n8\n");
        });
    });

}

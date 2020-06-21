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
import * as git from './git';
import * as assert from 'assert';
import { dirname } from 'path';
const root = dirname(__dirname);


require('source-map-support').install();


describe('LineLog', () => {
    it('empty', () => {
        let log = new LineLog;
        assert.equal(log.maxRev, 0);
        assert.equal(log.content, "");
    });

    it('single edit', () => {
        let log = new LineLog;
        log.recordText("c\nd\ne", 42);
        assert.equal(log.maxRev, 1);
        assert.equal(log.content, "c\nd\ne");
        assert.equal(log.getLineTimestamp(0), 42);
        assert.equal(log.getLineTimestamp(1), 42);
        assert.equal(log.getLineTimestamp(2), 42);
        assert.equal(log.getLineTimestamp(3), 0); // out of range
        assert.equal(log.lines[0].deleted, false);
    });

    it('multiple edits', () => {
        let log = new LineLog;
        log.recordText("c\nd\ne\n", 42);
        log.recordText("d\ne\nf\n", 52);
        assert.equal(log.maxRev, 2);
        assert.equal(log.content, "d\ne\nf\n");
        assert.equal(log.getLineTimestamp(0), 42);
        assert.equal(log.getLineTimestamp(1), 42);
        assert.equal(log.getLineTimestamp(2), 52);
        assert.equal(log.getLineTimestamp(3), 0); // out of range
        assert.equal(log.lines[0].deleted, false);
        assert.equal(log.lines[2].deleted, false);
    });

    it('checkout', () => {
        let log = new LineLog;
        log.recordText("c\nd\ne\n", 42);
        log.recordText("d\ne\nf\n", 52);
        log.checkOut(1);
        assert.equal(log.content, "c\nd\ne\n");
        log.checkOut(0);
        assert.equal(log.lines[0].deleted, false);
        assert.equal(log.content, "");
        assert.equal(log.getLineTimestamp(0), 0);
        log.checkOut(2);
        assert.equal(log.content, "d\ne\nf\n");
        assert.equal(log.lines[2].deleted, false);
    });

    it('checkout range', () => {
        let log = new LineLog;
        log.recordText("c\nd\ne\n", 42);
        log.recordText("d\ne\nf\n", 52);
        log.recordText("e\ng\nf\n", 62);

        log.checkOut(2, 1);
        assert.equal(log.content, "c\nd\ne\nf\n");
        assert(log.lines[0].deleted); // 'c' not in rev 2
        assert(!log.lines[1].deleted); // 'd' in rev 2
        assert(!log.lines[2].deleted);
        assert(!log.lines[3].deleted);

        log.checkOut(3, 0);
        assert.equal(log.content, "c\nd\ne\ng\nf\n");
        assert(log.lines[0].deleted); // 'c' not in rev 3
        assert(log.lines[1].deleted); // 'd' not in rev 3
        assert(!log.lines[2].deleted); // 'e' in rev 3

        log.checkOut(3, 2);
        assert.equal(log.content, "d\ne\ng\nf\n");
        assert(log.lines[0].deleted); // 'd' not in rev 3
        assert(!log.lines[1].deleted); // 'e' in rev 3
        assert(!log.lines[3].deleted); // 'f' in rev 3
    });

    it('serialize', () => {
        let log = new LineLog;
        log.recordText("c\nd\ne\n", 42);
        log.recordText("d\ne\nf\n", 52, { "foo": "bar" });
        let bytes = log.export();
        let log2 = new LineLog;
        log2.import(bytes);
        [1, 0, 2].forEach((i) => {
            log.checkOut(i);
            log2.checkOut(i);
            assert.equal(log2.content, log.content);
            [0, 1, 2, 3].forEach((line) => {
                assert.equal(log2.getLineTimestamp(line), log2.getLineTimestamp(line));
                assert.deepEqual(log2.getLineExtra(line), log2.getLineExtra(line));
            });
        });
    });
});

if (!process.env.GITHUB_WORKFLOW) {
    // GitHub Workflow uses shallow checkouts, which is incompatible with the tests.

    describe('GitObjectReader', () => {
        let reader = new git.GitObjectReader(root);

        it('raises on missing objects', async () => {
            assert.rejects(async () => await reader.getCommit("ee5d18cd8203abb02cc559a9af601b4fbab58911"), /missing/);
        });

        it('reads commits', async () => {
            let commit = await reader.getCommit("ee5d18cd8203abb02cc559a9af601b4fbab58910");
            assert.equal(commit.author.split(" <")[0], "Jun Wu");
            assert.equal(commit.timestamp, 1591577310);
            assert.equal(commit.message, "Add README");
        });

        it('reads files', async () => {
            let content = await reader.catFile("94fbc0acec88bdfc08b751aee74043de124582a1", ".gitignore");
            assert.equal(content, ".vscode\r\nnode_modules\r\n");
            content = await reader.catFile("ef99d08bf2bdf5ee3976b0ec0621b4214a568337", "fixtures/a");
            assert.equal(content, "5\n6\n7\n");
        });
    });

    describe("Git -> LineLog", () => {
        it('imports files', async () => {
            let b = await git.buildLineLogFromGitHistory(root, "fixtures/b");
            assert.equal(b.content, "3\n5\n6\n7\n");
            assert.equal((b.getLineExtra(0) as git.CommitPathInfo).commit.message, "Edit fixtures/a");
            assert.equal((b.getLineExtra(1) as git.CommitPathInfo).path, "fixtures/b");
            assert.equal((b.getLineExtra(2) as git.CommitPathInfo).path, "fixtures/a");
            assert.equal((b.getLineExtra(3) as git.CommitPathInfo).commit.timestamp, 1592698681);
            assert.equal(b.getLineTimestamp(3), 1592698681000);
            b.checkOut(b.maxRev, 0);
            assert.equal(b.content, "3\n4\n5\n5\n6\n7\n7\n8\n");
        });

        it('imports older files', async () => {
            let a = await git.buildLineLogFromGitHistory(
                root,
                "fixtures/a",
                { startingCommit: "a9ad1ca55280cea0f1109899d37d0cbb9b3efc1e" },
            );
            assert.equal(a.content, "3\n6\n7\n8\n");
            a.checkOut(a.maxRev, 0);
            assert.equal(a.content, "3\n4\n5\n6\n7\n7\n8\n");
        });
    });

}
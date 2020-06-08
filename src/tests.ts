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
import * as assert from 'assert';


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
        log.recordText("d\ne\nf\n", 52);
        let bytes = log.export();
        let log2 = new LineLog;
        log2.import(bytes);
        [1, 0, 2].forEach((i) => {
            log.checkOut(i);
            log2.checkOut(i);
            assert.equal(log2.content, log.content);
            [0, 1, 2, 3].forEach((line) => {
                assert.equal(log2.getLineTimestamp(line), log2.getLineTimestamp(line));
            });
        });
    });
});

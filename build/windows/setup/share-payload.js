// Keep the user installer intact. Encode the system installer as runs of shared
// bytes or literals. The two Inno outputs have the same compressed application
// with slightly different headers, setup metadata and optional signatures.
'use strict';
const fs = require('fs');
const [userFile, systemFile, outputFile] = process.argv.slice(2);
const user = fs.readFileSync(userFile);
const system = fs.readFileSync(systemFile);
const block = 64 * 1024;
const runs = [];
let shift = 0;

for (let start = 0; start < system.length; start += block) {
    const bytes = system.subarray(start, start + block);
    const expected = start + shift;
    let source = expected;
    if (expected < 0 || !user.subarray(expected, expected + bytes.length).equals(bytes)) {
        const low = Math.max(0, expected - 2 * block);
        const nearby = user.subarray(low, expected + 3 * block);
        const match = nearby.indexOf(bytes);
        source = match < 0 ? -1 : low + match;
    }
    if (source >= 0) shift = source - start;
    const last = runs[runs.length - 1];
    if (last && ((source === -1 && last.source === -1) ||
        (source >= 0 && last.source >= 0 && last.source + last.length === source))) {
        last.length += bytes.length;
    } else {
        runs.push({start, source, length: bytes.length});
    }
}

// Each header is a little-endian int32 source offset (-1 for literals) and length.
const fd = fs.openSync(outputFile, 'w');
try {
    for (const run of runs) {
        const header = Buffer.alloc(8);
        header.writeInt32LE(run.source, 0);
        header.writeInt32LE(run.length, 4);
        fs.writeFileSync(fd, header);
        if (run.source === -1) fs.writeFileSync(fd, system.subarray(run.start, run.start + run.length));
    }
} finally {
    fs.closeSync(fd);
}

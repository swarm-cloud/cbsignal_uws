const format = require("winston").format;
const { threadId } = require('worker_threads');

const commonFormat = [
    format.timestamp({ format: "YY-MM-DD HH:mm:ss" }),
    format.printf(
        (info) =>
            `${[info.timestamp]} ${info.level}: ${info.message}`
    ),
    format.errors({ stack: true }),
];

const workCommonFormat = [
    format.timestamp({ format: "YY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.printf(
        (info) =>
            `thread-${threadId} ${[info.timestamp]} ${info.level}: ${info.message}`
    ),
];

module.exports = {
    commonFormat,
    workCommonFormat,
}




const cluster = require('cluster');
const YAML = require('yamljs');
const pkg = require('./package.json');
const { Command } = require('commander');
const { startWorker } = require('./lib/worker');
const winston = require('winston');
require('winston-daily-rotate-file');
const logFormat = require("./lib/utils/log-format.js");
const { createLogger, format, transports } = winston;
const transportArr = [
    new transports.Console({
        level: 'info',
        format: format.combine(
            format.colorize({ all: true }),
            ...logFormat.commonFormat,
        ),
    })
];

let numCPUs = require("os").availableParallelism();
if (numCPUs > 2) {
    numCPUs --;
}
numCPUs = 2;    // test

const program = new Command();
program
    .name('cbsignal_uws')
    .description('SwarmCloud signaling server using uWebSockets.js')
    .version(pkg.version, '-v, --version', 'output the current version')
    .option('-c, --config [p]', 'The yaml file for config', 'config.yaml');
program.parse(process.argv);
const options = program.opts();
const configObject = YAML.load(options.config);
cluster.schedulingPolicy = cluster.SCHED_RR;

if (configObject.log?.writers === 'file') {
    const transport = new winston.transports.DailyRotateFile({
        filename: 'log/master-%DATE%.log',
        datePattern: 'YY-MM-DD',
        zippedArchive: true,
        maxSize: '1m',
        maxFiles: '14d',
        createSymlink: true,
        symlinkName: 'master.log',
        format: format.combine(
            ...logFormat.commonFormat,
        ),
    });
    transportArr.push(transport);
}

const logger = createLogger({
    level: configObject.log?.logger_level.toLowerCase() ?? 'warn',
    transports: transportArr,
});

function masterProc() {
    logger.warn(`master ${process.pid} is running`);
    if (numCPUs <= 1 || !configObject.redis) {
        // if (true) {
        // do not start worker thread and use redis
        startWorker(configObject)
    } else {
        for (let i = 0; i < numCPUs; i++) {
            logger.info(`forking process number ${i}...`);
            cluster.fork();
        }
        cluster.on("exit", (worker, code, signal) => {
            logger.warn(`worker ${worker.process.pid} died, fork another worker`);
            cluster.fork();
        });
    }
}

function childProc() {
    startWorker(configObject)
}

if (cluster.isPrimary) {
    masterProc();
} else {
    childProc()
}

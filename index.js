const cluster = require('cluster');
const ConfigLoader = require('./lib/utils/config-loader');
const pkg = require('./package.json');
const { Command } = require('commander');
const { startWorker } = require('./lib/worker');
const winston = require('winston');
require('winston-daily-rotate-file');
const logFormat = require("./lib/utils/log-format.js");
const { createLogger, format, transports } = winston;
const transportArr = [
    new transports.Console({
        format: format.combine(
            format.colorize({ all: true }),
            ...logFormat.commonFormat,
        ),
    })
];

let numCPUs = require("os").availableParallelism();

const program = new Command();
program
    .name('cbsignal_uws')
    .description('SwarmCloud signaling server using uWebSockets.js')
    .version(pkg.version, '-v, --version', 'output the current version')
    .option('-c, --config [p]', 'The yaml file for config', 'config/config.yaml');
program.parse(process.argv);
const options = program.opts();
if (process.env.SIGNAL_CONFIG_YAML) {
    options.config = process.env.SIGNAL_CONFIG_YAML;
}
const configLoader = new ConfigLoader()
    .loadFromYaml(options.config)
    .loadFromEnv('SIGNAL_');
const configObject = configLoader.config;
mergeENV(configObject);
cluster.schedulingPolicy = cluster.SCHED_RR;
if (configObject.log?.writers === 'file') {
    const { logger_dir, log_rotate_size, log_rotate_date } = configObject.log;
    const transport = new winston.transports.DailyRotateFile({
        filename: `master.log`,
        dirname: logger_dir || 'log',
        datePattern: 'YY-MM-DD',
        zippedArchive: true,
        maxSize: `${log_rotate_size || 1}m`,
        maxFiles: `${log_rotate_date || 1}d`,
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

if (cluster.isPrimary) {
    masterProc();
} else {
    childProc()
    process.on('uncaughtException', err => {
        logger.error('master caught exception: ' + err)
        logger.error(err.stack)
    });
}

function masterProc() {
    logger.warn(`master ${process.pid} is running, numCPUs ${numCPUs}`);
    if (process.env.WORKERS) {
        numCPUs = Number(process.env.WORKERS);
    } else {
        numCPUs--;
    }
    if (numCPUs <= 1 || !configObject.redis) {
        // if (true) {
        // do not start worker thread and use redis
        startWorker(configObject)
    } else {
        for (let i = 0; i < numCPUs; i++) {
            logger.info(`forking process number ${i}...`);
            setupWorker(cluster.fork());
        }
        cluster.on("exit", (worker, code, signal) => {
            logger.warn(`worker ${worker.process.pid} died, fork another worker`);
            setTimeout(() => {
                setupWorker(cluster.fork());
            }, 5000)
        });
        // cluster.on('online', () => {
        //     logger.info(`Worker is online`)
        //     const workers = Object.values(cluster.workers);
        //     const workerPids = workers.map(worker => worker.process.pid);
        //     for (const worker of workers) {
        //         worker.send(JSON.stringify({
        //             action: 'pids',
        //             data: workerPids,
        //         }));
        //     }
        // })
    }
}

function childProc() {
    startWorker(configObject)
}

function mergeENV(config) {
    const { REDIS_URL, PORT, TLS_PORT, CERT_PATH, KEY_PATH } = process.env;
    if (REDIS_URL) {
        config.redis = {
            url: REDIS_URL,
            is_cluster: false,
        }
    }
    if (PORT) {
        config.port = Number(PORT);
    }
    if (TLS_PORT && CERT_PATH && KEY_PATH) {
        config.tls = {
            port: Number(TLS_PORT),
            cert: CERT_PATH,
            key: KEY_PATH,
        }
    }
}

function setupWorker(worker) {
    worker.connections = 0;
    let timer = null;
    let missedPing = 0;
    timer = setInterval(() => {
        missedPing++
        worker.send(JSON.stringify({
            action: 'ping',
            connections: getConnections(),
            workers: Object.values(cluster.workers).length,
        }));
        if(missedPing > 5 ){
            process.kill(worker.process.pid);
            clearInterval(timer);
        }
    }, 5000);
    worker.on('exit', (code, signal) => {
        clearInterval(timer);
    })
    worker.on('message', (msg) => {
        msg = JSON.parse(msg);
        switch (msg.action) {
            case 'pong':
                missedPing = 0;
                worker.connections = msg.connections;
                break
            default:
                console.warn(`unknown action ${msg.action}`);
        }
    })
}

function getConnections() {
    let sum = 0;
    const workers = Object.values(cluster.workers);
    for (const worker of workers) {
        sum += worker.connections;
    }
    return sum
}

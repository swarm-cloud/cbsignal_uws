const { Worker, isMainThread, threadId, parentPort, setEnvironmentData } = require('worker_threads');
const { App, SSLApp } = require("uWebSockets.js");
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
const configObject = YAML.load(options.config);
mergeENV(configObject);
// cluster.schedulingPolicy = cluster.SCHED_RR;
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

if (isMainThread) {
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
    } else if (numCPUs === 2) {
        numCPUs = 1;
    }
    if (numCPUs <= 1 || !configObject.redis) {
        startWorker(configObject)
    } else {
        const acceptorApps = [];
        const { port, tls } = configObject;
        const ports = port ? (Array.isArray(port) ? port : [port]) : [];
        const sslPorts = tls ? (Array.isArray(tls) ? tls : [tls]) : [];
        for (let port of ports) {
            const acceptorApp = App({}).listen(port, (token) => {
                if (!token) {
                    logger.error(`Failed to listen to port ${port} from thread ${threadId}`);
                } else {
                    logger.warn(`listening to http ${port}`)
                }
            });
            acceptorApps.push(acceptorApp);
        }

        for (let item of sslPorts) {
            if (!item.key || !item.cert) continue;
            const acceptorApp = SSLApp({
                key_file_name: item.key,
                cert_file_name: item.cert,
            }).listen(item.port, (token) => {
                if (!token) {
                    logger.error(`Failed to listen to port ${item.port} from thread ${threadId}`);
                } else {
                    logger.warn(`listening to https ${item.port}`)
                }
            });
            acceptorApps.push(acceptorApp);
        }

        /* Main thread loops over all CPUs */
        /* In this case we only spawn two (hardcoded) */
        setEnvironmentData('workers', numCPUs);
        for (let i = 0; i < numCPUs; i++) {
            /* Spawn a new thread running this source file */
            spawnWorker(acceptorApps);
        }
    }
}

function spawnWorker(acceptorApps) {
    const worker = new Worker(__filename);
    worker.on("message", (workerAppDescriptor) => {
        acceptorApps.forEach(acceptorApp => {
            acceptorApp.addChildAppDescriptor(workerAppDescriptor);
        });
    });
    worker.on("exit", (exitCode) => {
        if (exitCode !== 0) {
            logger.warn(`worker ${worker.threadId} died, spawn another worker`);
            setTimeout(() => {
                spawnWorker(acceptorApps);
            }, 5000)
        }
    });
}

async function childProc() {
    const servers = await startWorker(configObject);
    servers.forEach(server => {
        parentPort.postMessage(server.app.getDescriptor());
    })

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

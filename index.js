const { Worker, isMainThread, threadId, parentPort, setEnvironmentData, getEnvironmentData} = require('worker_threads');
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
    } else {
        numCPUs -= 1;
    }
    if (numCPUs <= 1 || !configObject.redis) {
        startWorker(configObject)
    } else {
        const acceptorApps = [];
        const connections = {};
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
        const bc = new BroadcastChannel('connections');
        for (let i = 0; i < numCPUs; i++) {
            /* Spawn a new thread running this source file */
            spawnWorker(acceptorApps, connections, bc);
        }
    }
}

function spawnWorker(acceptorApps, connections, bc) {
    const worker = new Worker(__filename);
    worker.on("message", msg => {
        if (msg.descriptor) {
            acceptorApps.forEach(acceptorApp => {
                acceptorApp.addChildAppDescriptor(msg.descriptor);
            });
        } else if(Number.isInteger(msg.connections)) {
            connections[worker.threadId] = msg.connections;
            let total = 0;
            Object.values(connections).forEach(num => {
                total += num;
            })
            bc.postMessage(total);
            setEnvironmentData('connections', total);
        }

    });
    worker.on("exit", (exitCode) => {
        if (exitCode !== 0) {
            logger.warn(`worker ${worker.threadId} died, spawn another worker`);
            setTimeout(() => {
                spawnWorker(acceptorApps, connections, bc);
            }, 5000)
        }
    });
}

async function childProc() {
    const servers = await startWorker(configObject);
    servers.forEach(server => {
        parentPort.postMessage({
            descriptor: server.app.getDescriptor()
        });
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

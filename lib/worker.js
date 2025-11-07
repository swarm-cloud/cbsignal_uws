const winston = require('winston');
require('winston-daily-rotate-file');
const { workCommonFormat } = require("./utils/log-format.js");
const Server = require('./server');
const { getCertInfo, getSelfAddr, getWorkerAddr, randomNum } = require("./utils/tool");
const { loadProtoFile } = require("./utils/protoBuf");
const redis = require('./broker/redis');
const Nodes = require('./broker/nodes');
const Hub = require("./hub");
const { createLogger, format, transports } = winston;
const transportArr = [
    new transports.Console({
        format: format.combine(
            format.colorize({ all: true }),
            ...workCommonFormat,
        ),
    })
];

const servers = [];
const KEEP_LIVE_INTERVAL = 7 * 1000;

const startWorker = async (config = {}) => {
    // console.warn(config)
    const { port, tls, log, node = {} } = config;
    if (log?.writers === 'file') {
        setupLogFile(log)
    }
    const logger = createLogger({
        level: log?.logger_level.toLowerCase() ?? 'warn',
        transports: transportArr,
    });
    logger.warn(`Child PID: ${process.pid} running`);
    setupWorker(logger);
    const selfAddr = getSelfAddr();
    loadProtoFile();
    const nodes = new Nodes(selfAddr, logger, node.msg_consume_interval, node.max_pipe_length);
    const hub = new Hub(nodes, logger);
    setupNodes(nodes, hub);
    const ports = port ? (Array.isArray(port) ? port : [port]) : [];
    const sslPorts = tls ? (Array.isArray(tls) ? tls : [tls]) : [];
    let extra = {};
    if (sslPorts.length > 0) {
        extra.certInfos = [];
        for (let { cert } of sslPorts) {
            // 解析pem
            extra.certInfos.push(getCertInfo(cert));
        }
    }
    if (config.redis) {
        const { url, host, port, dbname, is_cluster: isCluster, cluster, password, username, local_cache_items } = config.redis
        if (url) {
            logger.info(`start connect redis url ${url}`);
            await redis.connectUrl(selfAddr, url, local_cache_items);
        } else if (isCluster) {
            logger.info(`start connect redis cluster`);
            await redis.connectCluster(selfAddr, cluster, username, password, local_cache_items);
        } else {
            logger.info(`start connect redis ${host}:${port} db ${dbname}`);
            await redis.connect(selfAddr, host, port, username, password, dbname, local_cache_items);
        }
        logger.info(`redis connected`);
        redis.updateClientCount(hub.numClient);
        setInterval(() => {
            redis.updateClientCount(hub.numClient);
        }, KEEP_LIVE_INTERVAL + randomNum(0, 500));
        hub.consume(selfAddr);
    }
    for (let item of [...ports, ...sslPorts]) {
        const server = new Server(hub, logger, item, config.stats, config.ratelimit, config.security, config.compression, config.compact, extra)
            .buildServer().run();
        servers.push(server);
    }
}

function setupLogFile(log) {
    const { logger_dir, log_rotate_size, log_rotate_date } = log;
    const transport = new winston.transports.DailyRotateFile({
        filename: `worker.log`,
        dirname: logger_dir || 'log',
        datePattern: 'YY-MM-DD',
        zippedArchive: true,
        maxSize: `${log_rotate_size || 1}m`,
        maxFiles: `${log_rotate_date || 1}d`,
        createSymlink: true,
        symlinkName: 'signalhub.log',
        format: format.combine(
            ...workCommonFormat,
        ),
    });
    transportArr.push(transport);
}

function setupWorker(logger) {
    process.on('uncaughtException', err => {
        logger.error('worker caught exception: ' + err);
        logger.error(err.stack);
    })
}

function setupNodes(nodes, hub) {
    process.on('message', (msg) => {
        // console.warn(msg)
        msg = JSON.parse(msg);
        switch (msg.action) {
            case 'ping':
                hub.numClientAllWorkers = msg.connections;
                hub.numWorkers = msg.workers;
                process.send(JSON.stringify({
                    action: 'pong',
                    connections: hub.numClient,
                }));
                break
            case 'pids':
                const pids = msg.data;
                for (let pid of pids) {
                    if (pid !== process.pid) {
                        const addr = getWorkerAddr(pid);
                        nodes.get(addr);
                    }
                }
                break
            default:
        }

    });
}


module.exports = {
    startWorker
}

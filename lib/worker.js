const winston = require('winston');
require('winston-daily-rotate-file');
const { workCommonFormat } = require("./utils/log-format.js");
const Server = require('./server');
const { getCertInfo, loadProtoFile, getSelfAddr} = require("./utils/tool");
const redis = require('./broker/redis');
const Nodes = require('./broker/nodes');
const Hub = require("./hub");
const { createLogger, format, transports } = winston;
const transportArr = [
    new transports.Console({
        level: 'info',
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
    const { port, tls, log } = config;
    if (log?.writers === 'file') {
        setupLogFile()
    }
    const logger = createLogger({
        level: log?.logger_level.toLowerCase() ?? 'warn',
        transports: transportArr,
    });
    logger.warn(`Child PID: ${process.pid} running`);
    const selfAddr = getSelfAddr();
    const ProtoBuf = await loadProtoFile();
    const nodes = new Nodes(selfAddr, ProtoBuf, logger);
    const hub = new Hub(nodes, ProtoBuf, logger);
    const ports = port ? (Array.isArray(port) ? port : [port]) : [];
    const sslPorts = tls ? tls : [];
    let extra = {};
    if (sslPorts.length > 0) {
        extra.certInfos = [];
        for (let { cert } of sslPorts) {
            // 解析pem
            extra.certInfos.push(getCertInfo(cert));
        }
    }
    if (config.redis) {
        const { host, port, dbname, is_cluster: isCluster, cluster, password, username } = config.redis
        if (isCluster) {
            logger.info(`${process.pid} start connect redis cluster`);
            await redis.connectCluster(selfAddr, cluster, username, password);
        } else {
            logger.info(`${process.pid} start connect redis ${host}:${port} db ${dbname}`);
            await redis.connect(selfAddr, host, port, username, password, dbname);
        }
        logger.info(`${process.pid} redis connected`);
        setInterval(() => {
            redis.updateClientCount(hub.numClient);
        }, KEEP_LIVE_INTERVAL);
        hub.consume(selfAddr);
    }
    for (let item of [...ports, ...sslPorts]) {
        const server = new Server(hub, logger, item, config.stats, config.ratelimit, config.security, config.compression, extra)
            .buildServer().run();
        servers.push(server);
    }
}

function setupLogFile() {
    const transport = new winston.transports.DailyRotateFile({
        filename: `log/worker-%DATE%.log`,
        datePattern: 'YY-MM-DD',
        zippedArchive: true,
        maxSize: '1m',
        maxFiles: '14d',
        createSymlink: true,
        symlinkName: 'worker.log',
        format: format.combine(
            ...workCommonFormat,
        ),
    });
    transportArr.push(transport);
}

module.exports = {
    startWorker
}

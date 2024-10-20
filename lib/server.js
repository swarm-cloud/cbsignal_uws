const { StringDecoder } = require("string_decoder");
const { App, SSLApp, DISABLED, SHARED_COMPRESSOR, us_socket_local_port } = require("uWebSockets.js");
const { RateLimiter } = require("limiter");
const { version } = require('../package.json');
const redis = require('./broker/redis');
const Client = require('./client');
const { checkToken, readJson, setCorsHeaders } = require("./utils/guard");
const { getCPULoadAVG, getLocalIp, getVersionNum, ensureDirectory } = require("./utils/tool");
// const cpuOverload = new (require('./utils/cpuOverload'))(10, 80, 0.8);
const decoder = new StringDecoder();
const inspector = require("node:inspector");
const fs = require("node:fs");
const versionNumber = getVersionNum(version);
const { threadId, isMainThread, getEnvironmentData } = require('worker_threads');

class Server {
    constructor(hub, logger, endPoint, stats, ratelimit, security, compression, extra = {}) {
        this.logger = logger;
        this.extra = extra;
        this.hub = hub;
        if (Number.isInteger(endPoint)) {
            this.port = endPoint;
            this.isSSL = false;
        } else {
            this.port = endPoint.port;
            this.cert = endPoint.cert;
            this.isSSL = endPoint.cert && endPoint.key;
        }
        this.ratelimit = ratelimit;
        if (ratelimit.enable) {
            this.limiter = new RateLimiter({ tokensPerInterval: ratelimit.max_rate, interval: "second" });
        }
        this.security = security || {};
        this.stats = stats || {};
        this.compression = compression || {};
        this.internalIp = getLocalIp();
        // cpuOverload.check().then().catch(err => {
        //     logger.error(err)
        // });
        this.app = this.isSSL ? SSLApp({
            key_file_name: endPoint.key,
            cert_file_name: endPoint.cert,
        }) : App();
    }

    buildServer() {
        this.app
            .get("/profile", async (response, request) => {
                if (!this._checkToken(request, response)) return;
                this.doProfile(request.getQuery("type"));
                setCorsHeaders(response);
                response.end('ok');
            })
            .get("/info", async (response, request) => {
                if (!this._checkToken(request, response)) return;
                response.onAborted(() => {
                    response.aborted = true;
                });
                const cpu = await getCPULoadAVG(1000, 100);
                const numClient = this.hub.numClient;
                // let current_connections = getEnvironmentData('connections');
                // console.warn(current_connections)
                if (!response.aborted) {
                    response.cork(() => {
                        setCorsHeaders(response);
                        response.end(JSON.stringify({
                            version,
                            workers: isMainThread ? 1 : getEnvironmentData('workers'),
                            current_connections: this.hub.currentConnectios,
                            total_connections: numClient + this.hub.nodes.getTotalNumClient(),
                            num_instance: this.hub.nodes.getNumNode(),    // master实例数
                            rate_limit: this.ratelimit.enable ? this.ratelimit.max_rate : undefined,
                            security_enabled: this.security.enable,
                            cpu_usage: cpu,
                            redis_connected: redis.getIsAlive(),
                            internal_ip: this.internalIp,
                            compression_enabled: this.compression.enable,
                            memory: process.memoryUsage(),
                            cert_infos: this.extra.certInfos,
                        }));
                    });
                }
            }).get("/count", (response, request) => {
                if (!this._checkToken(request, response)) return;
                setCorsHeaders(response);
                response.end(JSON.stringify(this.hub.numClient));
            }).get("/total_count", (response, request) => {
                if (!this._checkToken(request, response)) return;
                setCorsHeaders(response);
                response.end(JSON.stringify(this.hub.numClient + this.hub.nodes.getTotalNumClient()))
            }).get("/version", (response, request) => {
                if (!this._checkToken(request, response)) return;
                setCorsHeaders(response);
                response.end(version);
            })
            .get("/", (response, request) => {
                setCorsHeaders(response);
                const id = request.getQuery("id");
                if (!id || id.length < 6) {
                    response.writeStatus('401');
                    response.end();
                    return
                }
                let client = this.hub.getClient(id);
                if (client) {
                    if (!client.isPolling) {
                        response.writeStatus('409');
                        response.end();
                        return
                    }
                    if (client.msgQueue.length > 0) {
                        response.writeHeader("Content-Type", "application/json; charset=utf-8");
                        response.end(JSON.stringify(client.msgQueue));
                        client.msgQueue = [];
                        return
                    }
                    client.switchToPolling(response);
                } else {
                    client = new Client(response, id, true);
                    this.hub.doRegister(client);
                }
                response.writeHeader("Content-Type", "application/json; charset=utf-8");
                const endResp = () => {
                    clearTimeout(client.timer);
                    if (!response.aborted) {
                        let msg = client.msgQueue.length > 0 ? JSON.stringify(client.msgQueue) : undefined;
                        response.cork(() => {
                            if (msg) {
                                response.end(msg);
                            } else {
                                response.end();
                            }
                        });
                        // 节点离开
                        client._httpWriter = null;
                        if (!isMainThread) {
                            this.hub.doUnregister(id);
                        }
                    } else {
                        // 主动断开
                        this.hub.doUnregister(id);
                    }
                }
                let timer;
                response.onAborted(() => {
                    // console.warn(`${id} onAborted`);
                    response.aborted = true;
                    clearTimeout(timer);
                    endResp();
                });
                client.onAborted = () => {
                    clearTimeout(timer);
                    endResp();
                };
                timer = setTimeout(() => {
                    this.logger.info(`polling reach timeout`);
                    endResp();
                }, 120000);
            })
            .post("/", (response, request) => {
                setCorsHeaders(response);
                const id = request.getQuery("id");
                if (!id || id.length < 6) {
                    response.writeStatus('401');
                    response.end();
                    return
                }
                const token = request.getQuery("token");
                const isHello = request.getQuery()?.includes('hello');
                if (!this.checkRateLimit(response)) {
                    return
                }
                if (this.security.enable && !checkToken(id, token, this.security.token, this.security.max_timestamp_age, this.logger)) {
                    response.writeStatus('401');
                    response.end();
                    return
                }
                let client = this.hub.getClient(id);
                if (client) {
                    if (!client.isPolling) {
                        response.writeStatus('409');
                        response.end();
                        return
                    }
                }
                if (isHello) {
                    response.writeHeader("Content-Type", "application/json; charset=utf-8");
                    response.end(JSON.stringify({ver: versionNumber}));
                    return
                }
                readJson(response, (arr) => {
                    // array
                    if (Array.isArray(arr)) {
                        for (let msg of arr) {
                            this.hub.processMessage(msg, id);
                        }
                    }
                    response.end();
                }, () => {
                    /* Request was prematurely aborted or invalid or missing, stop reading */
                    // this.logger.warn('Invalid JSON or no data at all!');
                });
            })
            .ws("/*", {
                maxPayloadLength: 64 * 1024,
                idleTimeout: 300,
                compression: this.compression.enable ? SHARED_COMPRESSOR : DISABLED,
                maxConnections: 0,            // unlimited
                upgrade: this._onUpgrade.bind(this),
                open: this._onOpen.bind(this),
                message: this._onMessage.bind(this),
                close: this._onClose.bind(this),
                ping: this._onPing.bind(this),
             })
        return this
    }

    run() {
        this.app.listen(isMainThread ? this.port : 0, (token) => {
            if (token) {
                const port = us_socket_local_port(token);
                this.logger.warn(`worker ${threadId} is listening to ${this.isSSL ? 'https' : 'http'} ${port}`);
            } else {
                throw new Error(`Failed to listen to port ${this.port}`);
            }
        });
        return this
    }

    _checkToken(request, response) {
        const checkStatsToken = (token) => {
            if (this.stats.enable === false) return false
            if (!this.stats.token) return true
            return token === String(this.stats.token)
        }
        if (!checkStatsToken(request.getQuery("token"))) {
            response.writeStatus(`403 Forbidden`);
            setCorsHeaders(response);
            response.end();
            return false
        }
        return true
    }

    _onUpgrade(res, req, context) {
        // const url = req.getUrl();
        const secWebSocketKey = req.getHeader("sec-websocket-key");
        const secWebSocketProtocol = req.getHeader("sec-websocket-protocol");
        const secWebSocketExtensions = req.getHeader("sec-websocket-extensions");
        const id = req.getQuery("id");
        const token = req.getQuery("token");
        // if(!cpuOverload.isAvailable()){
        //     this.logger.warn(`cpu usage reach limit`);
        //     res.close();
        //     return
        // }
        if (this.limiter && !this.limiter.tryRemoveTokens(1)) {
            this.logger.warn(`request reach rate limit`);
            res.close();
            return
        }
        res.upgrade(
            { id, token },
            secWebSocketKey,
            secWebSocketProtocol,
            secWebSocketExtensions,
            context,
        );
    }

    _onOpen(ws) {
        const { id, token } = ws.getUserData();
        if (!id || id.length < 6) {
            ws.end(4000, 'id is not valid');
            return
        }
        if (this.security.enable && !checkToken(id, token, this.security.token, this.security.max_timestamp_age, this.logger)) {
            ws.end(4000, 'token is not valid');
            return
        }
        let client;
        if (this.hub.hasClient(id)) {
            // this.logger.info(`${id} is already exist`);
            client = this.hub.getClient(id);
            client.switchToWS(ws)
        } else {
            client = new Client(ws, id, false)
            this.hub.doRegister(client);
        }
        client.sendDataWs(JSON.stringify({
            action: 'ver',
            ver: versionNumber,
        }))
    }

    _onMessage(ws, message) {
        let json;
        try {
            json = JSON.parse(decoder.end(Buffer.from(message)));
        } catch (e) {
            this.logger.warn("failed to parse JSON message", e);
            return
        }
        const { id } = ws.getUserData();
        this.hub.processMessage(json, id);
    }

    _onClose(ws, code) {
        const { id } = ws.getUserData();
        ws.closed = true;
        this.hub.doUnregister(id)
    }

    _onPing(ws) {
        const { id } = ws.getUserData();
        const client = this.hub.getClient(id);
        if (client) {
            client.updateTs();
            redis.updateLocalPeerExpiration(id);
        }
    }

    checkRateLimit(response) {
        if (this.limiter && !this.limiter.tryRemoveTokens(1)) {
            this.logger.warn(`reach ratelimit ${this.ratelimit.max_rate}`);
            response.writeStatus('503');
            setCorsHeaders(response);
            response.end();
            return false
        }
        return true
    }

    async doProfile(type) {
        const { logger } = this;
        if (type === 'cpu') {
            logger.warn(`start cpu profile`);
            await ensureDirectory(`./profile`);
            const session = new inspector.Session();
            session.connect();
            session.post('Profiler.enable', () => {
                session.post('Profiler.start', () => {
                    setTimeout(() => {
                        session.post('Profiler.stop', (err, { profile }) => {
                            // Write profile to disk, upload, etc.
                            if (!err) {
                                logger.warn(`finish cpu profile`)
                                fs.writeFileSync(`./profile/${process.pid}.cpuprofile`, JSON.stringify(profile));
                            } else {
                                logger.error(`profile error`);
                                logger.error(err.stack);
                            }
                            session.post('Profiler.disable');
                        });
                    }, 15000);
                });
            });
        } else if (type === 'heap') {
            logger.warn(`start heap profile`);
            await ensureDirectory(`./profile`);
            const session = new inspector.Session();
            const fd = fs.openSync(`./profile/${process.pid}.heapsnapshot`, 'w');
            session.connect();
            session.on('HeapProfiler.addHeapSnapshotChunk', (m) => {
                logger.warn(`finish heap profile`);
                fs.writeSync(fd, m.params.chunk);
            });
            session.post('HeapProfiler.takeHeapSnapshot', null, (err, r) => {
                session.disconnect();
                fs.closeSync(fd);
            });
        }
    }

}

module.exports = Server

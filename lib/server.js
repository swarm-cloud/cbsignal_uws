const { StringDecoder } = require("string_decoder");
const { App, SSLApp, DISABLED, SHARED_COMPRESSOR } = require("uWebSockets.js");
const { RateLimiter } = require("limiter");
const { version } = require('../package.json');
const redis = require('./broker/redis');
const Client = require('./client');
const { checkToken, readJson, setCorsHeaders } = require("./utils/guard");
const { getCPULoadAVG, getLocalIp} = require("./utils/tool");

const decoder = new StringDecoder();

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
        this.app = this.isSSL ? SSLApp({
            key_file_name: endPoint.key,
            cert_file_name: endPoint.cert,
        }) : App();
    }

    buildServer() {
        this.app
            .get("/info", async (response, request) => {
                setCorsHeaders(response);
                if (!this.checkStatsToken(request.getQuery("token"))) {
                    response.writeStatus('403').end();
                    return
                }
                response.onAborted(() => {
                    response.aborted = true;
                });
                const cpu = await getCPULoadAVG(1000, 100);
                const numClient = this.hub.numClient;
                if (!response.aborted) {
                    response.cork(() => {
                        response.end(JSON.stringify({
                            version,
                            current_connections: numClient,
                            total_connections: numClient + this.hub.nodes.getTotalNumClient(),
                            num_instance: this.hub.nodes.getNumNode() + 1,
                            rate_limit: this.ratelimit.max_rate,
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
                setCorsHeaders(response);
                if (!this.checkStatsToken(request.getQuery("token"))) {
                    response.writeStatus('403').end();
                    return
                }
                response.end(JSON.stringify(this.hub.numClient));
            }).get("/total_count", (response, request) => {
                setCorsHeaders(response);
                if (!this.checkStatsToken(request.getQuery("token"))) {
                    response.writeStatus('403').end();
                    return
                }
            }).get("/version", (response, request) => {
                setCorsHeaders(response);
                if (!this.checkStatsToken(request.getQuery("token"))) {
                    response.writeStatus(`403 Forbidden`).end();
                    return
                }
                response.end(version);
            })
            .get("/", (response, request) => {
                setCorsHeaders(response);
                response.writeHeader("Content-Type", "application/json; charset=utf-8");
                const id = request.getQuery("id");
                if (!id) {
                    response.writeStatus('401').end();
                    return
                }
                const token = request.getQuery("token");
                if (!this.checkRateLimit(response)) {
                    return
                }
                if (this.security.enable && !checkToken(id, token, this.security.token, this.security.maxTimeStampAge, this.logger)) {
                    response.writeStatus('401').end();
                    return
                }
                let client = this.hub.getClient(id);
                if (client) {
                    if (!client.isPolling) {
                        response.writeStatus('409').end();
                        return
                    }
                    if (client.msgQueue.length > 0) {
                        response.end(JSON.stringify(client.msgQueue));
                        client.msgQueue = [];
                        return
                    }
                    client.switchToPolling(response);
                } else {
                    client = new Client(response, id, true);
                    this.hub.doRegister(client);
                }
                let timer;
                response.onAborted(() => {
                    // console.warn(`${id} onAborted`);
                    response.aborted = true;
                    clearTimeout(timer);
                    // 节点离开
                    if (client.isPolling) {
                        this.hub.doUnregister(id);
                    }
                });
                client.onAborted = () => {
                    clearTimeout(timer);
                    response.aborted = true;
                };
                timer = setTimeout(() => {
                    this.logger.info(`polling reach timeout`);
                    if (!response.aborted) {
                        response.cork(() => {
                            response.end();
                        });
                    }
                }, 120000);
            })
            .post("/", (response, request) => {
                setCorsHeaders(response);
                const id = request.getQuery("id");
                if (!id) {
                    response.writeStatus('401').end();
                    return
                }
                const token = request.getQuery("token");
                const isHello = request.getQuery()?.includes('hello');
                if (!this.checkRateLimit(response)) {
                    return
                }
                if (this.security.enable && !checkToken(id, token, this.security.token, this.security.maxTimeStampAge, this.logger)) {
                    response.writeStatus('401').end();
                    return
                }
                let client = this.hub.getClient(id);
                if (client) {
                    if (!client.isPolling) {
                        response.writeStatus('409').end();
                        return
                    }
                } else {
                    client = new Client(null, id, true);
                    this.hub.doRegister(client);
                }
                if (isHello) {
                    response.writeHeader("Content-Type", "application/json; charset=utf-8");
                    response.end(JSON.stringify({
                        action: 'ver',
                        ver: version,
                    }));
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
                    this.logger.warn('Invalid JSON or no data at all!');
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
        this.app.listen(this.port, (token) => {
            if (token) {
                this.logger.warn(`${process.pid} is listening to ${this.isSSL ? 'https' : 'http'} ${this.port}`);
            } else {
                throw new Error(`Failed to listen to port ${this.port}`);
            }
        });
        return this
    }

    _onUpgrade(res, req, context) {
        // const url = req.getUrl();
        const secWebSocketKey = req.getHeader("sec-websocket-key");
        const secWebSocketProtocol = req.getHeader("sec-websocket-protocol");
        const secWebSocketExtensions = req.getHeader("sec-websocket-extensions");
        const id = req.getQuery("id");
        if (!id) {
            res.close();
            return
        }
        const token = req.getQuery("token");
        // const origin = req.getHeader("origin");
        if (this.limiter && !this.limiter.tryRemoveTokens(1)) {
            res.close();
            return
        }
        if (this.security.enable && !checkToken(id, token, this.security.token, this.security.maxTimeStampAge, this.logger)) {
            res.close();
            return
        }
        res.upgrade(
            { id, token },
            /* Spell these correctly */
            secWebSocketKey,
            secWebSocketProtocol,
            secWebSocketExtensions,
            context,
        );
    }

    _onOpen(ws) {
        const { id } = ws.getUserData();
        if (this.hub.hasClient(id)) {
            this.logger.info(`${id} is already exist`);
            const client = this.hub.getClient(id);
            client.switchToWS(ws)
        } else {
            const client = new Client(ws, id, false)
            this.hub.doRegister(client);
        }
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
        // console.warn(`ws onMessage from ${id} pid ${process.pid}`);
        this.hub.processMessage(json, id);
    }

    _onClose(ws, code) {
        const { id } = ws.getUserData();
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

    checkStatsToken(token) {
        if (this.stats.enable === false) return false
        if (!this.stats.token) return true
        return token === String(this.stats.token)
    }

    checkRateLimit(response) {
        if (this.limiter && !this.limiter.tryRemoveTokens(1)) {
            this.logger.warn(`reach ratelimit ${this.ratelimit.max_rate}`);
            response.writeStatus('503').end();
            return false
        }
        return true
    }

}

module.exports = Server

const redis = require('./broker/redis');
const { getProtoBuf } = require("./utils/protoBuf");
const { randomNum, timeout} = require("./utils/tool");
const { LRUCache } = require('lru-cache');

const CHECK_CLIENT_INTERVAL = 6 * 60;        // 单位：秒
const MQ_BLOCK_DURATION = 7;

class Hub {
    constructor(nodes, logger) {
        this._map = new Map();
        this.nodes = nodes;
        this.logger = logger;
        this.numClientAllWorkers = 0;
        this.numWorkers = 0;
        this.filter = new LRUCache({
            max: 6000,
            allowStale: false,
            updateAgeOnGet: false,
            updateAgeOnHas: false,
        })
        setInterval(() => {
            this.checkConns();
        }, CHECK_CLIENT_INTERVAL * 1000 + randomNum(0, 10000))
    }

    doRegister(client) {
        this.logger.info(`${client.peerId} doRegister`);
        this._map.set(client.peerId, client);
        redis.setLocalPeer(client.peerId);
    }

    doUnregister(peerId) {
        if (this._map.has(peerId)) {
            this.logger.info(`${peerId} doUnregister`);
            this._map.delete(peerId);
            redis.delLocalPeer(peerId);
            return true
        }
        return false
    }

    async consume(addr) {
        const mqCli = redis.createRedisCli();
        while (true) {
            let b;
            try {
                b = await redis.blockPopMQ(mqCli, MQ_BLOCK_DURATION, addr);
            } catch (e) {
                this.logger.error(e);
                await timeout(MQ_BLOCK_DURATION * 1000);
            }
            // console.warn(`blpop end`)
            if (b) {
                // console.warn(`sendMessageToLocalPeer ${new Date()}`)
                this.sendMessageToLocalPeer(b);
            } else {
                this.logger.info(`consume mq is empty!`);
            }
        }
    }

    sendMessageToLocalPeer(raw) {
        const ProtoBuf = getProtoBuf();
        if (!ProtoBuf) {
            this.logger.error(`ProtoBuf not found`);
            return
        }
        const message = ProtoBuf.decode(raw);
        const object = ProtoBuf.toObject(message);
        for (let item of object.items) {
            const client = this.getClient(item.toPeerId);
            if (client) {
                this.logger.info(`local peer ${item.toPeerId} found`);
                const success = client.sendMessage(item.data.toString());
                if (!success && this.doUnregister(item.toPeerId)) {
                    this.logger.warn(`sendMessage to ${item.toPeerId} failed, doUnregister`);
                }
            }
        }
    }

    getClient(peerId) {
        return this._map.get(peerId)
    }

    hasClient(peerId) {
        return this._map.has(peerId)
    }

    removeClient(peerId) {
        this._map.delete(peerId);
    }

    sendJsonToClient(target, msg) {
        const success = target.sendMessage(JSON.stringify(msg));
        if (!success) {
            this.doUnregister(target.peerId);
        }
        return success
    }

    get numClient() {
        return this._map.size
    }

    clearAll() {
        this._map.clear();
    }

    processMessage(json, peerId) {
        // console.warn(`processMessage`)
        const { action } = json;
        if (!action) {
            const peer = this.getClient(peerId);
            if (peer) peer.updateTs();
            redis.updateLocalPeerExpiration(peerId);
            return
        }
        if (action === "ping" || action === "heartbeat") {
            this.processPing(json, peerId);
        } else {
            const toPeerId = json.to_peer_id || json.to;
            // console.warn(`peerId ${peerId} toPeerId ${toPeerId}`)
            delete json.to_peer_id;
            delete json.to;
            json.from_peer_id = peerId;
            if (action === "signal") {
                this.processSignal(json, toPeerId, peerId);
            } else if (action === "reject") {
                this.processReject(json, toPeerId, peerId);
            } else {
                this.logger.error(`unknown action ${action}`);
            }
        }
    }

    async processSignal(json, toPeerId, peerId) {
        const key = keyForFilter(peerId, toPeerId);
        if (this.filter.has(key)) return
        const target = this.getClient(toPeerId);
        if (target) {
            const success = this.sendJsonToClient(target, json);
            if (!success) {
                const peer = this.getClient(peerId);
                this._handlePeerNotFound(key, peer, toPeerId, peerId);
            }
            return
        }
        const peer = this.getClient(peerId);
        if (redis.getIsAlive()) {
            const addr = await redis.getRemotePeerAddr(toPeerId);
            // console.warn(`getRemotePeerAddr toPeerId ${toPeerId} addr ${addr}`)
            if (addr) {
                const node = await this.nodes.getNode(addr);
                if (node) {
                    if (!node.sendMsgSignal(json, toPeerId)) {
                        // this.logger.warn(`sendMsgSignal to remote failed`)
                    }
                } else {
                    this.logger.info(`node ${addr} not found`);
                    this._handlePeerNotFound(key, peer, toPeerId, peerId);
                }
                return
            }
        }
        this.logger.info(`peer ${toPeerId} not found`);
        this._handlePeerNotFound(key, peer, toPeerId, peerId);
    }

    processPing(json, peerId) {
        const peer = this.getClient(peerId);
        if (!peer) return
        this.logger.debug(`receive heartbeat from ${peerId}`);
        peer.updateTs();
        json.action = "pong";
        redis.updateLocalPeerExpiration(peerId);
        const success = peer.sendMessage(JSON.stringify(json));
        if (!success && this.doUnregister(peerId)) {
            this.logger.warn(`sendMessage to ${peerId} failed, doUnregister`);
        }
    }

    async processReject(json, toPeerId, peerId) {
        const key = keyForFilter(peerId, toPeerId);
        if (this.filter.has(key)) return
        const target = this.getClient(toPeerId);
        if (target) {
            this.filter.set(key, true);
            return this.sendJsonToClient(target, json);
        }
        if (redis.getIsAlive()) {
            const addr = await redis.getRemotePeerAddr(toPeerId);
            if (addr) {
                const node = await this.nodes.getNode(addr);
                if (node) {
                    if (!node.sendMsgSignal(json, toPeerId)) {
                        // this.logger.warn(`sendMsgSignal to remote failed`);
                        return
                    }
                    this.filter.set(key, true);
                } else {
                    this.logger.info(`node ${addr} not found`);
                }
            }
        }
    }

    async _handlePeerNotFound(key, client, toPeerId, peerId) {
        // this.logger.info(`_handlePeerNotFound ${client} ${toPeerId} ${peerId}`);
        this.filter.set(key, true);
        const msg = {
            action: 'signal',
            from_peer_id: toPeerId,
        }
        if (client) {
            return this.sendJsonToClient(client, msg);
        }
        // polling to another worker
        if (redis.getIsAlive()) {
            const addr = await redis.getRemotePeerAddr(peerId);
            if (addr) {
                const node = await this.nodes.getNode(addr);
                if (node) {
                    this.logger.info(`polling to another worker, send peer not found`);
                    if (!node.sendMsgSignal(msg, peerId)) {
                        this.logger.warn(`sendMsgSignal to remote ${addr} failed`);
                    }
                }
            }
        }
    }

    checkConns() {
        const now = Date.now();
        let wsCountRemoved = 0;
        let httpCountRemoved = 0;
        let wsCount = 0;
        let httpCount = 0;
        for (let [peerId, client] of this._map) {
            if (client.isExpired(now)) {
                this.doUnregister(peerId);
                client.close();
                if (client.isPolling) {
                    httpCountRemoved ++;
                } else {
                    wsCountRemoved ++;
                }
            } else {
                if (client.isPolling) {
                    httpCount ++;
                } else {
                    wsCount ++;
                }
            }
        }
        if (wsCountRemoved > 0 || httpCountRemoved > 0) {
            this.logger.warn(`check cmap finished, closed clients: ws ${wsCountRemoved} polling ${httpCountRemoved}`);
        }
        this.logger.warn(`current clients ws ${wsCount}, polling ${httpCount}`);
    }
}

function keyForFilter(from, to) {
    return from + to
}

module.exports = Hub


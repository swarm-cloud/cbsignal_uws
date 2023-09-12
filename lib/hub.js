const redis = require('./broker/redis');
const { getProtoBuf } = require("./utils/protoBuf");

const CHECK_CLIENT_INTERVAL = 6 * 60;        // 单位：秒
const MQ_BLOCK_DURATION = 7;

class Hub {
    constructor(nodes, logger) {
        this._map = new Map();
        this.nodes = nodes;
        this.logger = logger;
        setInterval(() => {
            this.checkConns();
        }, CHECK_CLIENT_INTERVAL * 1000)
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
              // console.warn(`blpop`)
             const b = await redis.blockPopMQ(mqCli, MQ_BLOCK_DURATION, addr);
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
                client.sendMessage(item.data.toString());
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
        return target.sendMessage(JSON.stringify(msg));
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
        if (action === "ping") {
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
                this.processReject(json, toPeerId);
            } else {
                this.logger.error(`unknown action ${action}`);
            }
        }
    }

    async processSignal(json, toPeerId, peerId) {
        const peer = this._map.get(peerId);
        const target = this.getClient(toPeerId);
        if (target) {
            // console.warn(`sendJsonToClient ${target.peerId}`);
            const success = this.sendJsonToClient(target, json);
            if (!success) {
                this._handlePeerNotFound(peer, toPeerId, peerId);
            }
            return
        }
        if (redis.getIsAlive()) {
            const addr = await redis.getRemotePeerAddr(toPeerId);
            // console.warn(`getRemotePeerAddr toPeerId ${toPeerId} addr ${addr}`)
            if (addr) {
                // 如果是本节点
                if (addr === this.nodes.selfAddr) {
                    this._handlePeerNotFound(peer, toPeerId, peerId);
                    return
                }
                const node = await this.nodes.getNode(addr);
                if (node) {
                    if (!node.sendMsgSignal(json, toPeerId)) {
                        // this.logger.warn(`sendMsgSignal to remote failed`)
                    }
                } else {
                    this.logger.info(`node ${addr} not found`);
                    this._handlePeerNotFound(peer, toPeerId, peerId);
                }
                return
            }
        }
        this.logger.info(`peer ${toPeerId} not found`);
        this._handlePeerNotFound(peer, toPeerId, peerId);
    }

    processPing(json, peerId) {
        const peer = this._map.get(peerId);
        if (!peer) return
        this.logger.debug(`receive heartbeat from ${peer.peerId}`);
        peer.updateTs();
        json.action = "pong";
        redis.updateLocalPeerExpiration(peer.peerId);
        peer.sendMessage(JSON.stringify(json));
    }

    async processReject(json, toPeerId) {
        const target = this.getClient(toPeerId);
        if (target) {
            target.filterAdd(toPeerId);
            return this.sendJsonToClient(target, json);
        }
        if (redis.getIsAlive()) {
            const addr = await redis.getRemotePeerAddr(toPeerId);
            if (addr) {
                // 如果是本节点
                if (addr === this.nodes.selfAddr) {
                    return
                }
                const node = await this.nodes.getNode(addr);
                if (node) {
                    if (!node.sendMsgSignal(json, toPeerId)) {
                        // this.logger.warn(`sendMsgSignal to remote failed`);
                        return
                    }
                    if (target) target.filterAdd(toPeerId);
                } else {
                    this.logger.info(`node ${addr} not found`);
                }
            }
        }
    }

    async _handlePeerNotFound(client, toPeerId, peerId) {
        // this.logger.info(`_handlePeerNotFound ${client} ${toPeerId} ${peerId}`);
        const msg = {
            action: 'signal',
            from_peer_id: toPeerId,
        }
        if (client) {
            client.filterAdd(toPeerId);
            return this.sendJsonToClient(client, msg);
        }
        // polling to another worker
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

module.exports = Hub


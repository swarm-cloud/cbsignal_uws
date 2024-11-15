const redis = require('./broker/redis');
const { getProtoBuf } = require("./utils/protoBuf");
const { randomNum, timeout} = require("./utils/tool");
// const { LRUCache } = require('lru-cache');
const compact = require("./compact");
// const decompact = require("./compact/decompact");

const CHECK_CLIENT_INTERVAL = 6 * 60;        // 单位：秒
const MQ_BLOCK_DURATION = 7;

class Hub {
    constructor(nodes, logger) {
        this._map = new Map();
        this.nodes = nodes;
        this.logger = logger;
        this.numClientAllWorkers = 0;
        this.numWorkers = 0;
        // this.filter = new LRUCache({
        //     max: 6000,
        //     allowStale: false,
        //     updateAgeOnGet: false,
        //     updateAgeOnHas: false,
        // })
        setInterval(() => {
            this.checkConns();
        }, CHECK_CLIENT_INTERVAL * 1000 + randomNum(0, 10000))
    }

    doRegister(client) {
        // this.logger.info(`${client.peerId} doRegister`);
        this._map.set(client.peerId, client);
        redis.setLocalPeer(client.peerId);
    }

    doUnregister(peerId) {
        if (this._map.has(peerId)) {
            // this.logger.info(`${peerId} doUnregister`);
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
                // this.logger.info(`consume mq is empty!`);
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
        let client;
        for (let item of object.items) {
            if (client && client.peerId === item.toPeerId) {
                // this.logger.warn(`hit peer ${item.toPeerId} cache`);
            } else {
                client = this.getClient(item.toPeerId);
            }
            if (client) {
                // this.logger.info(`local peer ${item.toPeerId} found`);
                // compact
                let raw = item.data.toString();
                if (client.isCompact) {
                    const json = JSON.parse(raw);
                    // this.logger.warn(`origin: ${raw}`);
                    const compacted = this._compactSignalMsg(json);
                    if (compacted) {
                        json.data = compacted;
                        json.from = json.from_peer_id;
                        json.from_peer_id = undefined;
                        raw = JSON.stringify(json);
                        // this.logger.warn(`compacted: ${raw}`);
                    }
                }
                const success = client.sendMessage(raw);
                if (!success && this.doUnregister(item.toPeerId)) {
                    // this.logger.info(`sendMessage to ${item.toPeerId} failed, doUnregister`);
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

    _compactSignalMsg(msg) {
        if (msg.action === 'signal' && msg.data) {
            return compact(msg.data);
        }
        return null
    }

    get numClient() {
        return this._map.size
    }

    clearAll() {
        this._map.clear();
    }

    processMessage(json, peerId, client) {
        // console.warn(`processMessage`)
        const { action } = json;
        if (!action) {
            client.updateTs();
            redis.updateLocalPeerExpiration(peerId);
            return
        }
        if (action === "ping" || action === "heartbeat") {
            this.processPing(client, json, peerId);
        } else {
            const toPeerId = json.to_peer_id || json.to;
            // console.warn(`peerId ${peerId} toPeerId ${toPeerId}`)
            json.to_peer_id = undefined;
            json.to = undefined;
            json.from_peer_id = peerId;
            const key = keyForFilter(peerId, toPeerId);
            const target = this.getClient(toPeerId);
            if (action === "signal") {
                // if (this.filter.has(key)) {
                //     return
                // }
                this.processSignal(client, target, json, toPeerId, peerId, key);
            } else if (action === "signals") {
                // if (this.filter.has(key)) {
                //     return
                // }
                this.processSignals(client, target, json, toPeerId, peerId, key);
            } else if (action === "reject" || action === "debug") {
                this.processCommon(target, json, toPeerId, key);
            } else {
                this.logger.warn(`unknown action ${action}`);
            }
        }
    }

    async processSignals(client, target, json, toPeerId, peerId, key) {
        const data = json.data;
        for (let item of data) {
            const msg = {
                action: 'signal',
                from_peer_id: json.from_peer_id,
                data: item,
            }
            if (!await this.processSignal(client, target, msg, toPeerId, peerId, key)) {
                break
            }
        }
    }

    async processSignal(client, target, json, toPeerId, peerId, key) {
        if (target) {
            // compact
            if (target.isCompact) {
                // this.logger.warn(`origin: ${JSON.stringify(json.data)}`);
                const compacted = this._compactSignalMsg(json);
                if (compacted) {
                //     // this.logger.warn(`compact: ${compacted.data}`);
                //     const decompacted = decompact(compacted.data);
                //     // this.logger.warn(`decompact: ${JSON.stringify(decompacted)}`);
                //     // this.logger.warn(`------------------------------------------`);
                    json.data = compacted;
                    json.from_peer_id = undefined;
                    json.from = peerId;
                //     const originData = (json.data.sdp || json.data.candidate.candidate)
                //     try {
                //         const result = compareStringArrays(originData.split("\r\n"), (decompacted.sdp || decompacted.candidate.candidate).split("\r\n"), {
                //             ignoreCase: true,
                //             ignoreOrder: true,
                //             trimWhitespace: true,
                //         })
                //         if (!result.isEqual) {
                //             if (result.differences.onlyInFirst.length > 0 && !result.differences.onlyInFirst[0].startsWith("o=mozilla")
                //             && !result.differences.onlyInFirst[0].startsWith("a=candidate:")) {
                //                 this.logger.warn(`onlyInFirst ${result.differences.onlyInFirst}`);
                //                 this.logger.warn(`onlyInSecond ${result.differences.onlyInSecond}`);
                //                 this.logger.warn(`origin: ${JSON.stringify(json.data)}`);
                //                 this.logger.warn(`compact: ${compacted.data}`);
                //                 this.logger.warn(`decompact: ${JSON.stringify(decompacted)}`);
                //                 this.logger.warn(`------------------------------------------`);
                //             }
                //         }
                //     } catch (e) {
                //         console.error(json.data)
                //         console.error(JSON.stringify(json.data))
                //         console.error(e)
                //     }
                }
            }
            const success = this.sendJsonToClient(target, json);
            if (!success) {
                this._handlePeerNotFound(key, client, toPeerId, peerId);
            }
            return success
        }
        if (redis.getIsAlive()) {
            const addr = await redis.getRemotePeerAddr(toPeerId);
            // console.warn(`getRemotePeerAddr toPeerId ${toPeerId} addr ${addr}`)
            if (addr) {
                const node = await this.nodes.getNode(addr);
                if (node) {
                    return node.sendMsgSignal(json, toPeerId)
                }
                this._handlePeerNotFound(key, client, toPeerId, peerId);
                return false
            }
        }
        // this.logger.info(`peer ${toPeerId} not found`);
        this._handlePeerNotFound(key, client, toPeerId, peerId);
        return false
    }

    processPing(client, json, peerId) {
        // this.logger.debug(`receive heartbeat from ${peerId}`);
        client.updateTs();
        json.action = "pong";
        redis.updateLocalPeerExpiration(peerId);
        const success = client.sendMessage(JSON.stringify(json));
        if (!success && this.doUnregister(peerId)) {
            // this.logger.info(`sendMessage to ${peerId} failed, doUnregister`);
        }
    }

    async processCommon(target, json, toPeerId, key) {
        if (target) {
            return this.sendJsonToClient(target, json);
        }
        if (redis.getIsAlive()) {
            const addr = await redis.getRemotePeerAddr(toPeerId);
            if (addr) {
                const node = await this.nodes.getNode(addr);
                if (node) {
                    if (!node.sendMsgSignal(json, toPeerId)) {
                        return
                    }
                } else {
                    // this.logger.info(`node ${addr} not found`);
                }
            }
        }
    }

    async _handlePeerNotFound(key, client, toPeerId, peerId) {
        // this.logger.info(`_handlePeerNotFound ${client} ${toPeerId} ${peerId}`);
        // this.filter.set(key, true);
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
                    // this.logger.info(`polling to another worker, send peer not found`);
                    if (!node.sendMsgSignal(msg, peerId)) {
                        // this.logger.warn(`sendMsgSignal to remote ${addr} failed`);
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
        // if (wsCountRemoved > 0 || httpCountRemoved > 0) {
        //     this.logger.warn(`check cmap finished, closed clients: ws ${wsCountRemoved} polling ${httpCountRemoved}`);
        // }
        this.logger.warn(`current clients ws ${wsCount}, polling ${httpCount}`);
    }
}

function keyForFilter(from, to) {
    return from + to
}

/**
 * 比较两个字符串数组并返回详细的差异信息
 * @param {string[]} arr1 - 第一个字符串数组
 * @param {string[]} arr2 - 第二个字符串数组
 * @param {Object} [options] - 比较选项
 * @param {boolean} [options.ignoreCase] - 是否忽略大小写
 * @param {boolean} [options.ignoreOrder] - 是否忽略元素顺序
 * @param {boolean} [options.trimWhitespace] - 是否忽略前后空格
 * @returns {Object} - 包含比较结果和差异详情的对象
 */
function compareStringArrays(arr1, arr2, options = {}) {
    const { ignoreCase = false, ignoreOrder = false, trimWhitespace = false } = options;

    // 预处理数组元素
    const processString = (str) => {
        let processed = str;
        if (trimWhitespace) {
            processed = processed.trim();
        }
        if (ignoreCase) {
            processed = processed.toLowerCase();
        }
        return processed;
    };

    const processedArr1 = arr1.map(processString);
    const processedArr2 = arr2.map(processString);

    // 创建Set以便于比较
    const set1 = new Set(processedArr1);
    const set2 = new Set(processedArr2);

    // 找出共同元素
    const common = processedArr1.filter((item) => set2.has(item));

    // 找出仅在第一个数组中的元素
    const onlyInFirst = processedArr1.filter((item) => !set2.has(item));

    // 找出仅在第二个数组中的元素
    const onlyInSecond = processedArr2.filter((item) => !set1.has(item));

    // 如果不忽略顺序，还需要检查顺序是否一致
    let isEqual = false;
    if (!ignoreOrder) {
        isEqual =
            processedArr1.length === processedArr2.length &&
            processedArr1.every((item, index) => item === processedArr2[index]);
    } else {
        isEqual = onlyInFirst.length === 0 && onlyInSecond.length === 0;
    }

    // 返回结果
    return {
        isEqual,
        differences: {
            onlyInFirst: onlyInFirst.map((_, index) => arr1[processedArr1.indexOf(onlyInFirst[index])]),
            onlyInSecond: onlyInSecond.map((_, index) => arr2[processedArr2.indexOf(onlyInSecond[index])]),
            common: common.map((_, index) => arr1[processedArr1.indexOf(common[index])])
        }
    };
}

module.exports = Hub


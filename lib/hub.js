const cluster = require('cluster');
const redis = require('./broker/redis');
const { getProtoBuf } = require("./utils/protoBuf");
const { randomNum, timeout} = require("./utils/tool");
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
        this.stats = {
            notFoundCount: 0,
            total: 1,
        };
        setInterval(() => {
            this.checkConns();
        }, CHECK_CLIENT_INTERVAL * 1000 + randomNum(0, 10000))
    }

    doRegister(client) {
        // this.logger.info(`${client.peerId} doRegister`);
        this._map.set(client.peerId, client);
        redis.setLocalPeer(client.peerId, client.isCompact ? '1' : undefined);
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
        let ProtoBuf = getProtoBuf();
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
                if (!ProtoBuf) {
                    ProtoBuf = getProtoBuf();
                    if (!ProtoBuf) {
                        this.logger.error(`ProtoBuf not found`);
                        return
                    }
                }
                const message = ProtoBuf.decode(b);
                const object = ProtoBuf.toObject(message);
                this.sendMessageToLocalPeerBatch(object.items);
            } else {
                // this.logger.info(`consume mq is empty!`);
            }
        }
    }

    sendMessageToLocalPeerBatch(items) {
        const map = new Map();
        for (let item of items) {
            const { toPeerId, data } = item;
            if (!map.has(toPeerId)) {
                map.set(toPeerId, [data]);
            } else {
                map.get(toPeerId).push(data);
            }
        }
        map.forEach((items, toPeerId) => {
            const client = this.getClient(toPeerId);
            if (client) {
                let success;
                if (client.batchable && items.length > 1) {
                    // 批量发送
                    const data = items.map(item => {
                        const json = JSON.parse(item.toString());   // pb => json
                        if (json.action === 'signal') json.action = undefined;
                        if (json.from_peer_id) {
                            json.from = json.from_peer_id;
                            json.from_peer_id = undefined;
                        }
                        return json
                    })
                    success = client.sendMessage(JSON.stringify({
                        action: 'signals',
                        data,
                    }));
                } else {
                    items.forEach(item => {
                        success = client.sendMessage(item.toString());
                    })
                }
                if (!success && this.doUnregister(toPeerId)) {
                    // this.logger.info(`sendMessage to ${item.toPeerId} failed, doUnregister`);
                }
            }
        })
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

    processMessage(json, peerId, client) {
        // console.warn(`processMessage`)
        const { action } = json;
        if (!action) {
            if (client) client.updateTs();
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
            const target = this.getClient(toPeerId);
            if (action === "signal") {
                this.processSignal(client, target, json, toPeerId, peerId);
            } else if (action === "signals") {
                this.processSignals(client, target, json, toPeerId, peerId);
            } else if (action === "reject" || action === "debug") {
                this.processCommon(target, json, toPeerId);
            } else {
                this.logger.warn(`unknown action ${action}`);
            }
        }
    }

    async processSignals(client, target, json, toPeerId, peerId) {
        const data = json.data;
        for (let item of data) {
            const msg = {
                action: 'signal',
                from_peer_id: json.from_peer_id,
                data: item,
            }
            if (!await this.processSignal(client, target, msg, toPeerId, peerId)) {
                break
            }
        }
    }

    _processJson(json, peerId, isCompact) {
        if (isCompact) {
            const compacted = compact(json.data);
            if (compacted) {
                // if (target.device === 'android') {
                //     this.logger.warn(`origin: ${JSON.stringify(json.data)}`);
                //     this.logger.warn(`compacted: ${compacted}`);
                // }

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
        return json
    }

    async _getRemotePeerInfo(toPeerId) {
        const info = await redis.getRemotePeerAddr(toPeerId);
        if (info) {
            const [addr, extra] = info.split(':');
            const isCompact = !!extra;
            const node = await this.nodes.getNode(addr);
            if (node) {
                return { node: node, isCompact }
            }
        }
        return { node: undefined }
    }

    async processSignal(client, target, json, toPeerId, peerId) {
        const { data } = json
        if (!data) return
        if (data.candidate && !data.candidate.candidate) {
            return
        }
        this.stats.total ++;
        if (target) {
            const success = this.sendJsonToClient(target, this._processJson(json, peerId, target.isCompact));
            if (!success) {
                this._handlePeerNotFound(client, toPeerId, peerId);
            }
            return success
        }
        if (redis.getIsAlive()) {
            const { node, isCompact } = await this._getRemotePeerInfo(toPeerId);
            if (node) {
                return node.sendMsgSignal(this._processJson(json, peerId, isCompact), toPeerId)
            }
            this._handlePeerNotFound(client, toPeerId, peerId);
            return false
        }
        // this.logger.info(`peer ${toPeerId} not found`);
        this._handlePeerNotFound(client, toPeerId, peerId);
        return false
    }

    processPing(client, json, peerId) {
        // this.logger.debug(`receive heartbeat from ${peerId}`);
        if (!client) return
        client.updateTs();
        json.action = "pong";
        redis.updateLocalPeerExpiration(peerId);
        const success = client.sendMessage(JSON.stringify(json));
        if (!success && this.doUnregister(peerId)) {
            // this.logger.info(`sendMessage to ${peerId} failed, doUnregister`);
        }
    }

    async processCommon(target, json, toPeerId) {
        if (target) {
            return this.sendJsonToClient(target, json);
        }
        if (redis.getIsAlive()) {
            const { node } = await this._getRemotePeerInfo(toPeerId);
            if (node) {
                if (!node.sendMsgSignal(json, toPeerId)) {
                    // return
                }
            } else {
                // this.logger.info(`node ${addr} not found`);
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
            if (toPeerId === client.notFoundIdCache) return
            client.notFoundIdCache = toPeerId;
            this.stats.notFoundCount ++;
            return this.sendJsonToClient(client, msg);
        }
        // polling to another worker
        if (!cluster.isPrimary && redis.getIsAlive()) {
            const { node } = await this._getRemotePeerInfo(peerId);
            if (node) {
                // this.logger.info(`polling to another worker, send peer not found`);
                if (!node.sendMsgSignal(msg, peerId)) {
                    // this.logger.warn(`sendMsgSignal to remote ${addr} failed`);
                } else {
                    this.stats.notFoundCount ++;
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
        this.logger.warn(`current clients ws ${wsCount}, polling ${httpCount}, hit cache ${((redis.stats.curCount/redis.stats.totalCount)*100).toFixed(2)}%, peerNotFound ${((this.stats.notFoundCount/this.stats.total)*100).toFixed(2)}%`);
        redis.stats.curCount = 0;
        redis.stats.totalCount = 1;
        this.stats = {
            notFoundCount: 0,
            total: 1,
        }
    }
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


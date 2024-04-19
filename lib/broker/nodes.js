const Node = require('./node');
const redis = require("./redis");

const PING_INTERVAL = 7 * 1000;
const PING_MAX_RETRYS = 2

class Nodes {
    constructor(selfAddr, logger) {
        this._map = new Map();
        this.selfAddr = selfAddr;
        this.logger = logger;
    }

    async getNode(addr) {
        return await this.get(addr)
    }

    getTotalNumClient() {
        let sum = 0;
        for (let node of this._map.values()) {
            sum += node.numClient;
        }
        return sum
    }

    getNumNode() {
        const set = new Set();
        for (let node of this._map.values()) {
            if (node.isAlive) {
                set.add(node.addr.split('-')[0]);
            }
        }
        set.add(this.selfAddr.split('-')[0]);
        return set.size
    }

    delete(node) {
        node.destroy();
        this.logger.warn(`nodeHub delete ${node.addr}`);
        this._map.delete(node.addr);
    }

    add(addr, node) {
        this.logger.info(`nodeHub add ${addr}`);
        this._map.set(addr, node);
        this._startHeartbeat(node);
    }

    _startHeartbeat(node) {
        node.timer = setInterval(async () => {
            if (node.pingRetrys > PING_MAX_RETRYS) {
                clearInterval(node.timer);
                this.delete(node);
                return
            }
            const count = await redis.getNodeClientCount(node.addr);
            if (count === -1) {
                this.logger.warn(`node heartbeat ${node.addr} err`);
                if (node.isAlive) {
                    node.isAlive = false;
                    // 清空队列
                    const len = await redis.getLenMQ(node.addr);
                    if (len === -1) {
                        this.logger.warn(`${node.addr} getLenMQ error`);
                    } else if (len > 0) {
                        redis.clearMQ(node.addr);
                    }
                }
                node.pingRetrys ++;
            } else {
                if (!node.isAlive) {
                    node.isAlive = true;
                }
                node.pingRetrys = 0;
                node.numClient = count;
            }
        }, PING_INTERVAL)
    }

    async get(addr) {
        let node = this._map.get(addr);
        if (!node) {
            const count = await redis.getNodeClientCount(addr);
            if (count >= 0) {
                this.logger.warn(`new Node ${addr}`);
                node = new Node(addr, this.logger);
                this.add(addr, node);
            } else {
                return null
            }
        }
        return node
    }

    clear() {
        this.logger.info(`clear nodes`);
        this._map.clear();
    }

}

module.exports = Nodes
